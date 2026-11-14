import * as z from 'zod';
import { ToolError } from '../lib/errors.ts';
import { clip, formatUnits, lines, parseUnits } from '../lib/format.ts';
import { EVM_DECIMALS, NATIVE_DECIMALS, NATIVE_TO_WEI, pickNetwork } from '../lib/networks.ts';
import { defineTool, networkField } from '../lib/tool.ts';

const UNITS = ['token', 'base', 'wei'] as const;
type Unit = (typeof UNITS)[number];

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1
/** The existential deposit in base units, the same on both networks (read on Nov 14, 2026). */
const ED_BASE = 10_000_000_000_000n;

/** "1.5e3" written out in full ("1500"), so the error message can show the exact number to send instead. */
function expandExponent(text: string): string | null {
  const m = /^\+?(\d*)(?:\.(\d*))?[eE]([+-]?\d{1,3})$/.exec(text);
  if (!m || (!m[1] && !m[2])) return null;
  const digits = `${m[1]}${m[2] ?? ''}`.replace(/^0+(?=\d)/, '');
  const point = (m[1] || '').length + Number(m[3]);
  const all = point >= digits.length ? digits + '0'.repeat(point - digits.length) : point <= 0 ? `0.${'0'.repeat(-point)}${digits}` : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const clean = all.includes('.') ? all.replace(/0+$/, '').replace(/\.$/, '') : all;
  return clean.replace(/^0+(?=\d)/, '') || '0';
}

const UNIT_WORDS: Record<string, string> = {
  tpot: 'that is unit "token"',
  pot: 'that is unit "token"',
  token: 'that is unit "token"',
  tokens: 'that is unit "token"',
  wei: 'that is unit "wei"',
  gwei: 'multiply by 1000000000 first, since 1 gwei is 1000000000 wei, and give it as unit "wei"',
  ether: 'ether means 18 decimals, which on this chain is the same token, so give it as unit "token"',
  eth: 'ether means 18 decimals, which on this chain is the same token, so give it as unit "token"',
  planck: 'that is unit "base"',
  base: 'that is unit "base"',
};

/** Reads the amount as text, refusing everything that is not a plain number, with a message that says how to write it. */
function amountText(amount: string | number): string {
  if (typeof amount === 'number') {
    if (amount < 0 || Object.is(amount, -0)) throw new ToolError('Amounts cannot be negative here: give the amount without a minus sign.');
    if (!Number.isInteger(amount)) throw new ToolError(`Pass an amount with decimals as a string, for example "${amount}", so no digit is lost on the way: a JSON number with decimals is a floating-point value.`);
    if (!Number.isSafeInteger(amount)) throw new ToolError(`${amount} is above 2^53 - 1 (9007199254740991), so as a JSON number it may already have lost digits. Pass it as a string of digits instead, for example "1500000000000000000".`);
    return String(amount);
  }
  const text = amount.trim();
  if (!text) throw new ToolError('The amount is empty. Give a number as a string, for example "1.5".');
  if (text.split(/\s+/).length >= 12) {
    throw new ToolError('That looks like a secret recovery phrase, not an amount. Never paste a secret phrase or a private key into a tool: these tools are read-only and never need one. If that phrase is real, treat the account as exposed and move its funds.');
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) {
    throw new ToolError('That is 32 bytes of hex: it looks like a private key or a hash, not an amount. Never paste a private key into a tool. An amount in hex (as eth_getBalance returns it) has no leading zeros and is far shorter.');
  }
  // Far longer than any amount: refused before any arithmetic, so a pasted mistake cannot hold the server.
  if (/^0x/i.test(text) && text.length > 66) {
    throw new ToolError(`That hex number has ${text.length} characters, far more than any amount: a 0x amount has at most 0x and 64 hex digits. Check what was pasted.`);
  }
  if (/^[-+]?[\d._]+$/.test(text) && text.length > 80) {
    throw new ToolError(`That number has ${text.length} characters, far more than any amount (at most 80 here). Check what was pasted.`);
  }
  const shown = clip(text, 100);
  if (/^-/.test(text)) throw new ToolError(`Amounts cannot be negative here: give "${clip(text.slice(1).trim(), 100)}" without the minus sign.`);
  const expanded = /[eE]/.test(text) && !/^0x/i.test(text) ? expandExponent(text) : null;
  if (expanded !== null) throw new ToolError(`Write the number out in full, without an exponent: "${shown}" is "${clip(expanded, 100)}". Exponents are refused because they hide rounding.`);
  if (text.includes(',')) throw new ToolError(`"${shown}" has a comma. Write it with digits and at most one dot, for example "1234.5": no thousands separators, and a dot (not a comma) for decimals.`);
  const glued = /^0x/i.test(text) ? null : /^([0-9._]+)\s*([a-zA-Z]+)$/.exec(text);
  if (glued) {
    const word = glued[2].toLowerCase();
    const hint = UNIT_WORDS[word];
    let example = `{"amount": "${clip(glued[1], 100)}", "unit": "${word === 'wei' ? 'wei' : word === 'base' || word === 'planck' ? 'base' : 'token'}"}`;
    if (word === 'gwei') {
      try {
        example = `{"amount": "${clip(String(parseUnits(glued[1], 9)), 100)}", "unit": "wei"}`;
      } catch {
        example = '{"amount": "<gwei x 1000000000>", "unit": "wei"}';
      }
    }
    throw new ToolError(`Give the number alone and put the unit in "unit": for example ${example}.${hint ? ` For "${glued[2]}": ${hint}.` : ' The units are "token", "base" and "wei".'}`);
  }
  if (/\s/.test(text)) throw new ToolError(`"${shown}" has a space in it. Write the number as one run of digits, with at most one dot, for example "1000000".`);
  return text;
}

function toWei(text: string, unit: Unit): bigint {
  const shown = clip(text, 100);
  if (/^0x/i.test(text)) {
    if (unit === 'token') throw new ToolError(`A hex number is a count of the smallest unit, so it cannot be a token amount. Give "${shown}" with unit "wei" (or "base" if it is a native amount).`);
    if (!/^0x[0-9a-f]+$/i.test(text)) throw new ToolError(`"${shown}" is not a hex number: after 0x come one or more of the characters 0-9 and a-f, and nothing else.`);
    return unit === 'base' ? BigInt(text) * NATIVE_TO_WEI : BigInt(text);
  }
  const plain = text.replace(/_/g, '');
  if (!/^\d*\.?\d*$/.test(plain) || !/\d/.test(plain)) throw new ToolError(`"${shown}" is not a plain decimal number. Write it with digits and at most one dot, for example "1.5", with no units, commas, spaces or exponent.`);
  if (unit === 'token') {
    const places = (plain.split('.')[1] ?? '').replace(/0+$/, '').length;
    if (places > EVM_DECIMALS) {
      throw new ToolError(`"${shown}" has ${places} decimal places. The smallest amount on either side is 1 wei, which is 0.000000000000000001 token (18 decimal places), so no amount can have more. Round it to at most 18 places, or at most 14 for a native amount.`);
    }
    return parseUnits(plain, EVM_DECIMALS);
  }
  if (plain.includes('.')) {
    const what = unit === 'base' ? 'base units' : 'wei';
    throw new ToolError(`An amount in ${what} is a whole number, so "${shown}" cannot be one. For a fraction of a token, give it with unit "token", for example {"amount": "${shown}", "unit": "token"}.`);
  }
  const n = BigInt(plain);
  return unit === 'base' ? n * NATIVE_TO_WEI : n;
}

export default defineTool({
  name: 'convert_amount',
  title: 'Portaldot V3: an amount in tokens, base units and wei',
  description:
    'Converts an amount of tPOT or POT between whole tokens, native base units (14 decimals) and wei (18 decimals, the Ethereum side), exactly, with BigInt. ' +
    'On Portaldot V3 the same token has 14 decimals on the native side and 18 on the Ethereum side, so a value from the wrong side is off by 10000. ' +
    'Returns the amount in all three units, the wei value as 0x hex for a JSON-RPC "value" field, a line of JavaScript for each form, which unit each API takes ' +
    '(Balances.transferKeepAlive and Revive.call take base units; msg.value, eth_getBalance, MetaMask and parseEther use wei), and warnings for amounts that do not fit. ' +
    'Use it before writing any amount into code or a transaction. It reads nothing from the chain. Example: {"amount": "1.5", "unit": "token"}.',
  input: {
    amount: z
      .union([z.string(), z.number()])
      .describe('The amount as a string of digits, with at most one dot for "token": "1.5", "150000000000000", "1500000000000000000". A whole number in hex ("0x14d1120d7b160000") is accepted for "base" and "wei". A JSON number is accepted only when it is a whole number below 2^53. No commas, spaces, exponents or unit names.'),
    unit: z.enum(UNITS).describe('What the amount counts: "token" for whole tPOT or POT (may have decimals, 1.5 means one and a half tokens); "base" for native base units (whole number, 1 token = 100000000000000); "wei" for the Ethereum side\'s smallest unit (whole number, 1 token = 1000000000000000000).'),
    network: networkField,
  },
  readsChain: false,
  handler: async ({ amount, unit, network: key }) => {
    const network = pickNetwork(key);
    const token = network.token;
    const text = amountText(amount);
    const wei = toWei(text, unit);
    const base = wei / NATIVE_TO_WEI;
    const leftover = wei % NATIVE_TO_WEI;
    const whole = leftover === 0n;
    const tokens = formatUnits(wei, EVM_DECIMALS);
    const hex = `0x${wei.toString(16)}`;
    const nativeOk = whole;

    const warnings: string[] = [];
    if (!whole) {
      warnings.push(
        unit === 'wei'
          ? `- ${wei} wei is not a whole number of base units: it is ${base} base units and ${leftover} wei left over (1 base unit is 10000 wei). A native call cannot carry the remainder.`
          : `- ${tokens} ${token} has more than 14 decimal places, so it is not a whole number of base units: it is ${base} base units and ${leftover} wei left over. A native call can carry at most 14 decimal places.`,
        '  The Revive module keeps a small remainder below one base unit for each account, called dust (the dust field of revive.accountInfoOf). What happens to such a value in general is not known to us, so keep Ethereum-side values multiples of 10000 wei.',
      );
    }
    if (base > 2n ** 128n - 1n) warnings.push(`- ${base} base units is more than a u128 can hold (2^128 - 1), so no balance or call argument on this chain can carry it. Check the amount and its unit.`);
    const big: string[] = [];
    if (base > MAX_SAFE) big.push(`base units ${base}`);
    if (wei > MAX_SAFE) big.push(`wei ${wei}`);
    if (big.length) warnings.push(`- Above 2^53 - 1 (9007199254740991), so not exact as a JavaScript Number: ${big.join(' and ')}. Keep ${big.length > 1 ? 'them' : 'it'} a BigInt (the n suffix) or a string, never a Number.`);

    const parseLine = tokens.includes('.') && tokens.split('.')[1].length > NATIVE_DECIMALS ? null : `parseUnits('${tokens}', 14) in ethers or viem gives the same`;
    const code = [`const tokens = '${tokens}';`, `const base = ${base}n;`, `const wei = ${wei}n;`, `const value = '${hex}';`];
    const jsWidth = Math.max(...code.map((c) => c.length)) + 2;
    const js = (c: string, note: string): string => `  ${c.padEnd(jsWidth)}// ${note}`;
    const label = (l: string): string => `${l}:`.padEnd(41);
    const head =
      unit === 'token'
        ? `${tokens} ${token} in all three units, exact.`
        : `${text} ${unit === 'base' ? 'base units' : 'wei'} is ${tokens} ${token}, here in all three units, exact.`;

    return lines(
      `${head} Computed here: nothing was read from the chain.`,
      '',
      `${label(`token (${token}, what people read)`)}${tokens}`,
      `${label('base units (native side, 14 decimals)')}${base}${whole ? '' : `  plus ${leftover} wei left over (not a whole number of base units)`}`,
      `${label('wei (Ethereum side, 18 decimals)')}${wei}`,
      `${label('wei as hex (a JSON-RPC "value" field)')}${hex}`,
      '',
      'In JavaScript (amounts as BigInt or strings, never as Number):',
      js(code[0], 'a string: parse it, never use a Number for amounts'),
      nativeOk
        ? js(code[1], `native: api.tx.balances.transferKeepAlive(dest, base)${parseLine ? `; ${parseLine}` : ''}`)
        : js(code[1], `native: only the whole part; ${leftover} wei cannot be sent natively`),
      js(code[2], `Ethereum side: { value: wei } in ethers or viem; parseEther('${tokens}') gives the same`),
      js(code[3], `the "value" of a raw JSON-RPC transaction; '0x' + wei.toString(16)`),
      warnings.length ? ['', 'Warnings:', ...warnings] : null,
      '',
      'Which unit goes where:',
      `- base units (14 decimals): native calls and storage. Balances.transferKeepAlive, the value of Revive.call (the contract then sees msg.value = value x 10000), System.account (data.free, reserved, frozen), and the existential deposit (0.1 ${token} = ${ED_BASE} base units, read on Nov 14, 2026).`,
      `- wei (18 decimals): msg.value inside a contract, eth_getBalance, the value of an Ethereum transaction, MetaMask, and parseEther in ethers and viem.`,
      `- So parseEther("1") (${10n ** 18n}n) is right for an Ethereum transaction and 10000 times too much as a native value, where 1 ${token} is ${10n ** 14n}n (10n ** 14n).`,
      `- Converting: wei = base units x 10000; base units = wei / 10000, which is exact only when wei is a multiple of 10000.`,
    );
  },
});
