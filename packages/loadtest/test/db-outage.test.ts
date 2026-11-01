import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { auditRoom, CaseRecord, PKG_DIR, rectOp, sleep, startStack, TestClient } from '../src/lib.ts';
import { uid } from './helpers.ts';

const pgctl = (command: 'stop' | 'start') =>
  execFileSync('bash', [path.join(PKG_DIR, 'pg.sh'), command], { stdio: 'ignore' });

test('database outage does not take the server down', async () => {
  const record = new CaseRecord('db-outage');
  const stack = await startStack('db-outage');
  let databaseUp = true;
  try {
    const client = await TestClient.connect(stack.ws.url, stack.token);
    client.join(stack.roomId);
    await sleep(100);
    const before = uid('before');
    client.send(rectOp(stack.roomId, before));
    await client.waitFor(() => Boolean(client.ackFor(before)));

    pgctl('stop');
    databaseUp = false;
    await sleep(300);

    // Every message type that touches the database, sent during the outage.
    const during = uid('during');
    client.send(rectOp(stack.roomId, during));
    const opError = await client.waitFor(() => client.ofType('error').length > 0, 15_000);
    client.send({ type: 'chat', roomId: stack.roomId, message: 'during outage' });
    await sleep(300);
    const aliveAfterOp = await stack.ws.alive();

    const joiner = aliveAfterOp ? await TestClient.connect(stack.ws.url, stack.token) : null;
    joiner?.join(stack.roomId);
    await sleep(3000);
    const aliveAfterJoin = await stack.ws.alive();
    const exitDuringOutage = stack.ws.exitInfo();

    pgctl('start');
    databaseUp = true;
    await sleep(1000);

    let recovered = false;
    if (aliveAfterJoin && client.isOpen) {
      const after = uid('after');
      client.send(rectOp(stack.roomId, after));
      recovered = await client.waitFor(() => Boolean(client.ackFor(after)), 15_000);
    }
    const audit = await auditRoom(stack.pool, stack.roomId);

    record.fact('errorFrameForOp', opError);
    record.fact('aliveAfterOpAndChat', aliveAfterOp);
    record.fact('aliveAfterJoin', aliveAfterJoin);
    record.fact('exitDuringOutage', exitDuringOutage);
    record.fact('logTail', aliveAfterJoin ? null : stack.ws.logTail(6));
    record.check('op during the outage gets an error frame', opError);
    record.check('server survives op and chat during the outage', aliveAfterOp, stack.ws.exitInfo());
    record.check('server survives join_room during the outage', aliveAfterJoin, exitDuringOutage);
    record.check('failed join_room gets an error frame', (joiner?.ofType('error').length ?? 0) > 0);
    record.check('ops flow again once the database returns', recovered);
    record.check('db seq contiguous after the outage', audit.contiguousFromOne && audit.currentSeqMatchesMax);
    client.close();
    joiner?.close();
  } finally {
    if (!databaseUp) pgctl('start');
    await stack.shutdown();
  }
  record.finish();
});
