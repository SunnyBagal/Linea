// Drives the real web app in Chrome against the local backends. Needs Google Chrome
// and the local Postgres from pg.sh. Run with: pnpm e2e
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright-core';
import {
  auditRoom, CaseRecord, REPO_ROOT, resultsDir, sleep, startStack, waitForPort,
} from '../src/lib.ts';
import { HTTP_PORT, startHttp } from '../test/helpers.ts';

const WEB_PORT = 13100;
const screenshot = path.join(resultsDir(), 'chaos', 'e2e-rollback-notice.png');
type Frame = Record<string, any>;

interface Tab { page: Page; frames: Frame[] }

async function openBoard(browser: import('playwright-core').Browser, slug: string, token: string, wsUrl: string): Promise<Tab> {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript((value) => localStorage.setItem('token', value), token);
  const page = await context.newPage();
  const frames: Frame[] = [];
  page.on('websocket', (ws) => {
    // The dev server has its own hot reload socket.
    if (!ws.url().startsWith(wsUrl)) return;
    ws.on('framereceived', (frame) => frames.push(JSON.parse(String(frame.payload))));
  });
  await page.goto(`http://localhost:${WEB_PORT}/canvas/${slug}`);
  await until(() => frames.some((f) => f.type === 'room_joined'), 'room_joined', 60_000);
  await sleep(500);
  return { page, frames };
}

async function until(condition: () => boolean, what: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const pixels = ({ page }: Tab) => page.evaluate(() => document.querySelector('canvas')!.toDataURL());

// The in-progress preview leaves round caps and joins on the context, so a tab that
// has drawn renders line ends differently. Match that, then click to force a redraw.
async function renderLikeTheAuthor({ page }: Tab) {
  await page.evaluate(`(() => {
    const context = document.querySelector('canvas').getContext('2d');
    context.lineCap = 'round';
    context.lineJoin = 'round';
  })()`);
  await page.mouse.click(1100, 700);
  await sleep(100);
}

async function drag({ page }: Tab, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 4 });
  await page.mouse.up();
}

test('browser: a rejected op rolls back with a notice, and tabs converge', async () => {
  const record = new CaseRecord('e2e-rollback');
  const stack = await startStack('e2e-rollback');
  const http = await startHttp('e2e-rollback', { env: { CORS_ORIGINS: `http://localhost:${WEB_PORT}` } });
  const web = spawn(path.join(REPO_ROOT, 'apps/web/node_modules/.bin/next'), ['dev', '-p', String(WEB_PORT)], {
    cwd: path.join(REPO_ROOT, 'apps/web'),
    stdio: 'ignore',
    detached: true,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_HTTP_URL: `http://127.0.0.1:${HTTP_PORT}`,
      NEXT_PUBLIC_WS_URL: stack.ws.url,
    },
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const block = () => stack.pool.query(`ALTER TABLE "Operation" ADD CONSTRAINT lt_block CHECK (false) NOT VALID`);
  const unblock = () => stack.pool.query(`ALTER TABLE "Operation" DROP CONSTRAINT IF EXISTS lt_block`);
  try {
    await waitForPort(WEB_PORT, 60_000);
    const { rows } = await stack.pool.query(`SELECT slug FROM "Room" WHERE id = $1`, [stack.roomId]);
    const slug = rows[0].slug as string;

    const author = await openBoard(browser, slug, stack.token, stack.ws.url);
    const observer = await openBoard(browser, slug, stack.token, stack.ws.url);
    const notice = author.page.getByRole('status');
    const errors = () => author.frames.filter((f) => f.type === 'error');
    const acks = () => author.frames.filter((f) => f.type === 'op_ack');

    await author.page.keyboard.press('r');
    await drag(author, [200, 200], [320, 280]);
    await until(() => acks().length === 1, 'first ack');
    await sleep(100);
    const oneRect = await pixels(author);
    const firstShape = acks()[0]!.shapeId;

    // A rejected CREATE.
    await block();
    await drag(author, [400, 200], [520, 280]);
    await until(() => errors().length === 1, 'error for the rejected CREATE');
    await sleep(100);
    record.check('rejected CREATE: frame names the shape', errors()[0]!.opType === 'CREATE' && errors()[0]!.shapeId !== firstShape, errors()[0]);
    record.check('rejected CREATE: canvas goes back', await pixels(author) === oneRect);
    record.check('rejected CREATE: notice shows', await notice.isVisible());
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await author.page.screenshot({ path: screenshot });

    // The notice doesn't block drawing. Its undo step is gone, so undo targets the first shape.
    await author.page.keyboard.press('Control+z');
    await until(() => errors().length === 2, 'error for the rejected undo');
    await sleep(100);
    record.check('rejected CREATE: its undo step is removed', errors()[1]!.opType === 'DELETE' && errors()[1]!.shapeId === firstShape, errors()[1]);
    record.check('rejected undo: canvas goes back', await pixels(author) === oneRect);

    await unblock();
    await author.page.keyboard.press('Control+z');
    await until(() => acks().length === 2, 'ack for the retried undo');
    await sleep(100);
    record.check('rejected undo: its step can be retried', acks()[1]!.shapeId === firstShape && await pixels(author) !== oneRect);

    await notice.waitFor({ state: 'hidden', timeout: 6000 });
    record.check('notice clears by itself', !(await notice.isVisible()));

    // A rejected drag.
    await drag(author, [600, 350], [760, 450]);
    await until(() => acks().length === 3, 'ack for the drag target');
    await author.page.keyboard.press('v');
    await author.page.mouse.click(600, 400);
    await sleep(100);
    const selected = await pixels(author);
    await block();
    await drag(author, [600, 400], [680, 460]);
    await until(() => errors().length === 3, 'error for the rejected UPDATE');
    await sleep(100);
    record.check('rejected drag: frame is the UPDATE', errors()[2]!.opType === 'UPDATE', errors()[2]);
    record.check('rejected drag: shape returns to where it was', await pixels(author) === selected);
    await unblock();

    // A drag that saves, drawn while the other tab watches.
    await drag(author, [600, 400], [680, 460]);
    await until(() => acks().length === 4, 'ack for the saved drag');
    await author.page.mouse.click(1100, 700);
    await sleep(300);

    const audit = await auditRoom(stack.pool, stack.roomId);
    record.fact('dbRows', audit.rows);
    record.fact('errorFrames', errors().length);
    record.check('only accepted ops are in the database', audit.rows === 4 && audit.contiguousFromOne, audit.rows);
    await renderLikeTheAuthor(observer);
    record.check('watching tab matches the author exactly', await pixels(observer) === await pixels(author));
    const observerOps = observer.frames.filter((f) => f.type === 'op');
    record.check('watching tab saw only accepted ops', observerOps.length === 4, observerOps.length);

    const late = await openBoard(browser, slug, stack.token, stack.ws.url);
    await renderLikeTheAuthor(late);
    record.check('tab opened afterwards matches exactly', await pixels(late) === await pixels(author));
  } finally {
    await unblock().catch(() => {});
    await browser.close();
    try { process.kill(-web.pid!, 'SIGTERM'); } catch { /* already gone */ }
    await http.stop();
    await stack.shutdown();
  }
  record.finish();
});
