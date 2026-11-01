import { test } from 'node:test';
import {
  auditRoom, CaseRecord, rectOp, sleep, startBackend, startStack, TestClient, type Backend,
} from '../src/lib.ts';
import { BrowserSession, startHttp, uid } from './helpers.ts';

async function restartCase(signal: 'SIGKILL' | 'SIGTERM') {
  const name = `restart-${signal.toLowerCase()}`;
  const record = new CaseRecord(name);
  const stack = await startStack(name);
  const http = await startHttp(name);
  let replacement: Backend | undefined;
  try {
    const room = stack.roomId;
    const writers = await Promise.all([0, 1].map(() => TestClient.connect(stack.ws.url, stack.token)));
    const observer = await TestClient.connect(stack.ws.url, stack.token);
    for (const client of [...writers, observer]) client.join(room);
    await sleep(200);

    const sent: string[] = [];
    const burst = (clients: TestClient[]) => setInterval(() => {
      for (const client of clients) {
        if (!client.isOpen) continue;
        const shapeId = uid('op');
        sent.push(shapeId);
        client.send(rectOp(room, shapeId));
      }
    }, 3);

    let timer = burst(writers);
    await sleep(3000);
    const killedAt = performance.now();
    stack.ws.proc.kill(signal);
    await Promise.all([...writers, observer].map((c) => c.waitFor(() => c.closeCode !== null, 10_000)));
    const closeCodes = [...writers, observer].map((c) => c.closeCode);
    const allClosedMs = performance.now() - killedAt;
    clearInterval(timer);
    await stack.ws.stop();

    const ackedBefore = writers.flatMap((c) => c.ofType('op_ack'));
    const ackedSeqBefore = new Map(ackedBefore.map((a) => [a.shapeId as string, a.seq as number]));
    const auditDown = await auditRoom(stack.pool, room);

    replacement = await startBackend('ws', stack.wsPort, `${name}-after`);
    const reconnected = await Promise.all([0, 1].map(() => TestClient.connect(replacement!.url, stack.token)));
    const observerAfter = await TestClient.connect(replacement.url, stack.token);
    const sessions = [...reconnected, observerAfter].map((c) => new BrowserSession(c, room, stack.token));
    await Promise.all(sessions.map((s) => s.start()));
    timer = burst(reconnected);
    await sleep(3000);
    clearInterval(timer);
    await sleep(1000);
    sessions.forEach((s) => s.stop());

    const audit = await auditRoom(stack.pool, room);
    const lostAcked = [...ackedSeqBefore].filter(([id, seq]) => audit.bySeq.get(seq) !== id);
    const inDb = new Set(audit.bySeq.values());
    const persistedUnacked = [...inDb].filter((id) => sent.includes(id)
      && !ackedSeqBefore.has(id) && !reconnected.some((c) => c.ackFor(id))).length;
    const diffs = sessions.map((s) => s.diff(audit));
    const ackedAfter = reconnected.flatMap((c) => c.ofType('op_ack'));

    record.fact('closeCodes', closeCodes);
    record.fact('allClosedMs', allClosedMs);
    record.fact('exitBeforeRestart', stack.ws.exitInfo());
    record.fact('ackedBeforeKill', ackedBefore.length);
    record.fact('rowsWhenDown', auditDown.rows);
    record.fact('persistedButNeverAcked', persistedUnacked);
    record.fact('ackedAfterRestart', ackedAfter.length);
    record.fact('sessionDiffs', diffs);

    record.check('every acked op survives the restart with its seq', lostAcked.length === 0, { lost: lostAcked.length });
    record.check('db seq contiguous across the restart', audit.contiguousFromOne);
    record.check('currentSeq equals max seq', audit.currentSeqMatchesMax);
    record.check('seq numbers continue after the restart', ackedAfter.every((a) => a.seq > (auditDown.maxSeq ?? 0)));
    record.check('writers make progress after the restart', ackedAfter.length > 0);
    record.check('reconnected clients have no missing ops', diffs.every((d) => d.missing === 0), diffs);
    record.check('reconnected clients have no duplicate ops', diffs.every((d) => d.duplicates === 0), diffs);
    if (signal === 'SIGTERM') {
      // Railway sends SIGTERM on deploys. Clients should get a proper close, not 1006.
      record.check('SIGTERM closes sockets with 1001 or 1012',
        closeCodes.every((code) => code === 1001 || code === 1012), { closeCodes });
      record.check('SIGTERM acks or fails in-flight ops before exit', persistedUnacked === 0, { persistedUnacked });
    }
    [...reconnected, observerAfter].forEach((c) => c.close());
  } finally {
    await replacement?.stop();
    await http.stop();
    await stack.shutdown();
  }
  record.finish();
}

test('server restart mid-session: crash (SIGKILL)', () => restartCase('SIGKILL'));
test('server restart mid-session: deploy (SIGTERM)', () => restartCase('SIGTERM'));
