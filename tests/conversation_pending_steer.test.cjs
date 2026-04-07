const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function loadPendingSteerModule() {
  const filePath = path.resolve(__dirname, '../src/core/conversation_pending_steer.js');
  const source = await fs.readFile(filePath, 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(dataUrl);
}

test('pendingSteerTargetsTurn prefers explicit turnId match', async () => {
  const { pendingSteerTargetsTurn } = await loadPendingSteerModule();

  const pendingSteer = {
    id: 'steer-1',
    targetTurnId: 'turn_active',
    targetTurnStartedAtMs: 123
  };

  assert.equal(pendingSteerTargetsTurn(pendingSteer, 'turn_active', 999), true);
  assert.equal(pendingSteerTargetsTurn(pendingSteer, 'turn_other', 123), false);
});

test('pendingSteerTargetsTurn falls back to turnStartedAtMs when turnId is absent', async () => {
  const { pendingSteerTargetsTurn } = await loadPendingSteerModule();

  const pendingSteer = {
    id: 'steer-2',
    targetTurnId: null,
    targetTurnStartedAtMs: 456
  };

  assert.equal(pendingSteerTargetsTurn(pendingSteer, null, 456), true);
  assert.equal(pendingSteerTargetsTurn(pendingSteer, null, 789), false);
});

test('splitPendingSteersByTurn keeps matched and remaining order stable', async () => {
  const { splitPendingSteersByTurn } = await loadPendingSteerModule();

  const pendingSteers = [
    { id: 'steer-a', targetTurnId: 'turn-1', payload: { originalMessageText: 'A' } },
    { id: 'steer-b', targetTurnId: 'turn-2', payload: { originalMessageText: 'B' } },
    { id: 'steer-c', targetTurnId: 'turn-1', payload: { originalMessageText: 'C' } }
  ];

  const result = splitPendingSteersByTurn(pendingSteers, { turnId: 'turn-1' });

  assert.deepEqual(result.matched.map(item => item.id), ['steer-a', 'steer-c']);
  assert.deepEqual(result.remaining.map(item => item.id), ['steer-b']);
});

test('splitPendingSteersByTurnIds supports stable attempt id plus legacy assistant message id aliases', async () => {
  const { splitPendingSteersByTurnIds } = await loadPendingSteerModule();

  const pendingSteers = [
    { id: 'steer-attempt', targetTurnId: 'attempt-1', payload: { originalMessageText: 'A' } },
    { id: 'steer-legacy-ai', targetTurnId: 'ai-msg-1', payload: { originalMessageText: 'B' } },
    { id: 'steer-other', targetTurnId: 'attempt-2', payload: { originalMessageText: 'C' } }
  ];

  const result = splitPendingSteersByTurnIds(pendingSteers, {
    turnIds: ['attempt-1', 'ai-msg-1']
  });

  assert.deepEqual(result.matched.map((item) => item.id), ['steer-attempt', 'steer-legacy-ai']);
  assert.deepEqual(result.remaining.map((item) => item.id), ['steer-other']);
});

test('collectPendingSteersForFollowUpWindow keeps steer pending when no natural follow-up exists', async () => {
  const { collectPendingSteersForFollowUpWindow } = await loadPendingSteerModule();

  const result = collectPendingSteersForFollowUpWindow(
    [
      { id: 'steer-keep', targetTurnId: 'turn-1', payload: { originalMessageText: 'KEEP' } }
    ],
    {
      turnId: 'turn-1',
      hasNaturalFollowUp: false
    }
  );

  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.remaining.map((item) => item.id), ['steer-keep']);
});

test('collectPendingSteersForFollowUpWindow accepts matching steer when natural follow-up exists', async () => {
  const { collectPendingSteersForFollowUpWindow } = await loadPendingSteerModule();

  const result = collectPendingSteersForFollowUpWindow(
    [
      { id: 'steer-accept', targetTurnId: 'turn-1', payload: { originalMessageText: 'ACCEPT' } },
      { id: 'steer-other', targetTurnId: 'turn-2', payload: { originalMessageText: 'OTHER' } }
    ],
    {
      turnId: 'turn-1',
      hasNaturalFollowUp: true
    }
  );

  assert.deepEqual(result.accepted.map((item) => item.id), ['steer-accept']);
  assert.deepEqual(result.remaining.map((item) => item.id), ['steer-other']);
});

test('buildRestoredQueueJobFromPendingSteer creates queued follow-up for completed turn', async () => {
  const { buildRestoredQueueJobFromPendingSteer } = await loadPendingSteerModule();

  let serial = 0;
  const restored = buildRestoredQueueJobFromPendingSteer(
    {
      id: 'steer-completed',
      payload: {
        originalMessageText: 'STEER_TEXT',
        inputImagesHtmlSnapshot: '',
        inputHasScreenshotSnapshot: false
      }
    },
    {
      createJobId: () => `job-${++serial}`,
      conversationId: 'conv_1',
      conversationRevisionAtEnqueue: 7,
      retryPolicy: { enabled: true, maxAttempts: 5 },
      status: 'queued',
      createdAt: 1000
    }
  );

  assert.deepEqual(restored, {
    id: 'job-1',
    kind: 'append_user_message',
    status: 'queued',
    paused: false,
    conversationId: 'conv_1',
    conversationRevisionAtEnqueue: 7,
    anchorMessageId: '',
    targetAiMessageId: '',
    payload: {
      originalMessageText: 'STEER_TEXT',
      inputImagesHtmlSnapshot: '',
      inputHasScreenshotSnapshot: false
    },
    retryPolicy: { enabled: true, maxAttempts: 5 },
    retryCount: 0,
    availableAt: null,
    staleReason: null,
    failureMessage: null,
    queuedAt: 1000,
    createdAt: 1000
  });
});

test('buildRestoredQueueJobsFromPendingSteers creates paused jobs for interrupted turn', async () => {
  const { buildRestoredQueueJobsFromPendingSteers } = await loadPendingSteerModule();

  let serial = 0;
  const restoredJobs = buildRestoredQueueJobsFromPendingSteers(
    [
      { id: 'steer-1', payload: { originalMessageText: 'ONE' } },
      { id: 'steer-2', payload: { originalMessageText: 'TWO' } }
    ],
    {
      createJobId: () => `job-${++serial}`,
      conversationId: 'conv_interrupt',
      conversationRevisionAtEnqueue: 3,
      retryPolicy: { enabled: true, maxAttempts: 5 },
      status: 'paused',
      failureMessage: 'Interrupted before the steer was accepted.',
      createdAt: 2000
    }
  );

  assert.deepEqual(
    restoredJobs.map((job) => ({
      id: job.id,
      status: job.status,
      paused: job.paused,
      text: job.payload.originalMessageText,
      failureMessage: job.failureMessage
    })),
    [
      {
        id: 'job-1',
        status: 'paused',
        paused: true,
        text: 'ONE',
        failureMessage: 'Interrupted before the steer was accepted.'
      },
      {
        id: 'job-2',
        status: 'paused',
        paused: true,
        text: 'TWO',
        failureMessage: 'Interrupted before the steer was accepted.'
      }
    ]
  );
});

test('resolvePendingSteerRestoreDisposition distinguishes completed and interrupted outcomes', async () => {
  const { resolvePendingSteerRestoreDisposition } = await loadPendingSteerModule();

  assert.deepEqual(resolvePendingSteerRestoreDisposition('completed'), {
    status: 'queued',
    failureMessage: null
  });
  assert.deepEqual(resolvePendingSteerRestoreDisposition('interrupted'), {
    status: 'paused',
    failureMessage: '当前生成在接受转向输入前被中断'
  });
  assert.deepEqual(resolvePendingSteerRestoreDisposition('error'), {
    status: 'paused',
    failureMessage: '当前生成在接受转向输入前结束'
  });
});
