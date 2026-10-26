import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
test('demo runs real runtime/channel/API modules locally and cleans its isolated multi-account state', async () => {
  const started = Date.now();
  const { stdout, stderr } = await run(process.execPath, [fileURLToPath(new URL('../scripts/demo.mjs', import.meta.url))], {
    timeout: 30000, maxBuffer: 64 * 1024,
  });
  assert.equal(stderr, '');
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.mode, 'local_fake_weixin');
  assert.equal(evidence.realWeChatDelivery, false);
  assert.equal(evidence.networkRequests, 0);
  assert.ok(Date.now() - started < 30000);
  for (const key of ['threeIndependentLogins', 'threePollersLive', 'independentHistories', 'exactReplyRoutes',
    'ownerOnlyBrief', 'elderReminderRoute', 'failedSendAccurate', 'noAutomaticRetry', 'credentialsPrivate', 'closedAndCleaned']) {
    assert.equal(evidence.checks[key], true, key);
  }
  assert.deepEqual(evidence.counts, {
    people: 3, logins: 3, pollAccounts: 3, inbound: 3, replyApiAccepted: 3,
    briefApiAccepted: 1, welcomeApiAccepted: 2, reminderApiAccepted: 1, failed: 1, retries: 0,
  });
  assert.equal(evidence.apiAttempts.length, 8);
  assert.deepEqual(evidence.apiAttempts.map(row => [row.person, row.kind, row.outcome]).sort(), [
    ['dad', 'reply', 'api_accepted'], ['mom', 'reply', 'api_accepted'], ['owner', 'reply', 'api_accepted'],
    ['owner', 'owner_brief', 'api_accepted'], ['mom','member_welcome','api_accepted'], ['dad','member_welcome','api_accepted'], ['dad', 'reminder', 'api_accepted'], ['mom', 'manual', 'failed'],
  ].sort());
  assert.doesNotMatch(stdout, /Bearer|fixture-token|fixture-context|auth\.json|family\.json/);
});
