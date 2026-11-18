// What get_account and estimate_eth_transaction say about transactions that wait for a block, from
// the two numbers the node gives: the account's nonce and system_accountNextIndex. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitingCount, waitingText } from '../../src/lib/accounts.ts';

test('nothing waiting: said plainly, with what the count cannot show (a nonce gap)', () => {
  const t = waitingText({ nonce: 12, next: 12 });
  assert.equal(waitingCount({ nonce: 12, next: 12 }), 0);
  assert.match(t, /^nothing of this account is waiting for a block \(system_accountNextIndex 12 equals the nonce\)\./);
  assert.match(t, /A transaction signed with a later nonce, above 12, would not show here: the node holds such a transaction apart, unseen, until the missing nonce is sent\./);
});

test('one waiting transaction: the count, the next nonce, and what a second one with its nonce does', () => {
  const t = waitingText({ nonce: 12, next: 13 });
  assert.equal(waitingCount({ nonce: 12, next: 13 }), 1);
  assert.match(t, /^1 transaction of this account is waiting for its block: taken by the node, not in a block yet \(system_accountNextIndex 13, nonce 12\)\./);
  assert.match(t, /A new transaction sent after it takes nonce 13\. One signed with nonce 12 competes with a waiting one: with the same fees it is refused with 1014 \(Priority is too low\), with a higher fee or tip it replaces it \(measured on Nov 15, 2026\)\./);
});

test('several waiting transactions: plural words and the range of their nonces', () => {
  const t = waitingText({ nonce: 12, next: 15 });
  assert.equal(waitingCount({ nonce: 12, next: 15 }), 3);
  assert.match(t, /^3 transactions of this account are waiting for their block/);
  assert.match(t, /sent after them takes nonce 15\. One signed with a nonce from 12 to 14 competes/);
});

test('a block that lands between the two reads never makes the count negative', () => {
  // the next index is read first, then the nonce: a transaction included in between counts as done
  assert.equal(waitingCount({ nonce: 13, next: 12 }), 0);
  assert.match(waitingText({ nonce: 13, next: 12 }), /^nothing of this account is waiting/);
});

test('the texts are plain ASCII on one line', () => {
  for (const p of [{ nonce: 0, next: 0 }, { nonce: 0, next: 1 }, { nonce: 5, next: 9 }]) assert.match(waitingText(p), /^[\x20-\x7e]+$/);
});
