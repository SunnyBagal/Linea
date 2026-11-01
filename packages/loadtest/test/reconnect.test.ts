import { test } from 'node:test';
import { auditRoom, CaseRecord, rectOp, sleep, startStack, TestClient } from '../src/lib.ts';
import { BrowserSession, pace, startHttp, uid } from './helpers.ts';

test('client disconnects mid-burst and reconnects with the browser catch-up flow', async () => {
  const record = new CaseRecord('reconnect-mid-burst');
  const stack = await startStack('reconnect');
  const http = await startHttp('reconnect');
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    writer.join(stack.roomId);
    await sleep(100);
    const writerPacer = pace(() => writer, stack.roomId, 4, 'writer');

    const cycles = 8;
    const sessions: BrowserSession[] = [];
    let victimSent = 0;
    const victimSentIds: string[] = [];
    const victimAckedIds = new Set<string>();

    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const victim = await TestClient.connect(stack.ws.url, stack.token);
      const session = new BrowserSession(victim, stack.roomId, stack.token);
      sessions.push(session);
      await session.start();

      const burst = setInterval(() => {
        if (!victim.isOpen) return;
        const shapeId = uid('victim');
        victimSentIds.push(shapeId);
        victimSent += 1;
        victim.send(rectOp(stack.roomId, shapeId));
      }, 2);
      await sleep(600);
      clearInterval(burst);
      // Abrupt drop while ops are still in flight.
      victim.terminate();
      session.stop();
      for (const ack of victim.ofType('op_ack')) victimAckedIds.add(ack.shapeId);
      await sleep(150);
    }

    // A final session that stays connected and observes until writes stop.
    const finalClient = await TestClient.connect(stack.ws.url, stack.token);
    const finalSession = new BrowserSession(finalClient, stack.roomId, stack.token);
    await finalSession.start();
    await sleep(500);
    writerPacer.stop();
    await sleep(1000);
    finalSession.stop();

    const audit = await auditRoom(stack.pool, stack.roomId);
    const inDb = new Set(audit.bySeq.values());
    const persistedUnacked = victimSentIds.filter((id) => inDb.has(id) && !victimAckedIds.has(id)).length;
    const lostUnacked = victimSentIds.filter((id) => !inDb.has(id) && !victimAckedIds.has(id)).length;
    const ackedMissing = [...victimAckedIds].filter((id) => !inDb.has(id)).length;
    const diffs = [...sessions, finalSession].map((session) => session.diff(audit));
    const totalMissing = diffs.reduce((sum, diff) => sum + diff.missing, 0);
    const totalDuplicates = diffs.reduce((sum, diff) => sum + diff.duplicates, 0);

    record.fact('cycles', cycles);
    record.fact('victimSent', victimSent);
    record.fact('victimAcked', victimAckedIds.size);
    record.fact('persistedButNeverAcked', persistedUnacked);
    record.fact('droppedUnacked', lostUnacked);
    record.fact('sessionDiffs', diffs);
    record.fact('dbRows', audit.rows);

    record.check('server survives abrupt disconnects', await stack.ws.alive(), stack.ws.exitInfo());
    record.check('every acked op is in the database', ackedMissing === 0, { ackedMissing });
    record.check('db seq contiguous from 1', audit.contiguousFromOne);
    record.check('currentSeq equals max seq', audit.currentSeqMatchesMax);
    record.check('catch-up leaves no missing ops', totalMissing === 0, { totalMissing });
    record.check('catch-up leaves no duplicate ops', totalDuplicates === 0, { totalDuplicates });
    record.check('final session matches the database exactly',
      finalSession.diff(audit).missing === 0 && finalSession.diff(audit).duplicates === 0, finalSession.diff(audit));
    writer.close();
    finalClient.close();
  } finally {
    await http.stop();
    await stack.shutdown();
  }
  record.finish();
});
