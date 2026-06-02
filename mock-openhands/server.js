#!/usr/bin/env node
/**
 * Mock OpenHands API Server
 * Simulates the OpenHands REST API for testing Autobug integration
 */

require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.OPENHANDS_PORT || 3000;

// Store active sessions
const sessions = new Map();

app.use(express.json());

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

/**
 * POST /api/run-agent
 * Main endpoint that Autobug calls to start an AI agent session
 */
app.post('/api/run-agent', async (req, res) => {
  const { prompt, targetRepoUrl } = req.body;

  console.log('\n🤖 [Mock OpenHands] Received agent request:');
  console.log(`   Target Repo: ${targetRepoUrl}`);
  console.log(`   Prompt: ${prompt?.substring(0, 100)}...`);

  if (!prompt || !targetRepoUrl) {
    return res.status(400).json({
      error: 'Missing required fields: prompt, targetRepoUrl'
    });
  }

  // Generate session ID
  const sessionId = uuidv4();

  // Store session
  sessions.set(sessionId, {
    id: sessionId,
    status: 'running',
    prompt,
    targetRepoUrl,
    startedAt: new Date(),
    steps: []
  });

  console.log(`\n✅ [Mock OpenHands] Session created: ${sessionId}`);

  // Start async "work" simulation
  simulateAgentWork(sessionId, prompt, targetRepoUrl);

  // Return immediately with session_id
  res.json({
    session_id: sessionId,
    status: 'started',
    message: 'Agent session started successfully'
  });
});

/**
 * GET /api/sessions/:id
 * Check status of a running session
 */
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    session_id: session.id,
    status: session.status,
    target_repo: session.targetRepoUrl,
    started_at: session.startedAt,
    steps_completed: session.steps.length,
    current_step: session.steps[session.steps.length - 1] || null
  });
});

/**
 * GET /api/sessions/:id/logs
 * Get logs from a session
 */
app.get('/api/sessions/:id/logs', (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    session_id: session.id,
    logs: session.steps.map((step, i) => ({
      step: i + 1,
      action: step.action,
      timestamp: step.timestamp,
      details: step.details
    }))
  });
});

/**
 * Simulate AI agent work
 */
async function simulateAgentWork(sessionId, prompt, targetRepoUrl) {
  const session = sessions.get(sessionId);
  const steps = [
    { action: 'clone_repo', details: `Cloning ${targetRepoUrl}...`, delay: 1000 },
    { action: 'analyze_codebase', details: 'Analyzing repository structure...', delay: 1500 },
    { action: 'classify_issue', details: 'Classifying issue as: frontend', delay: 800 },
    { action: 'find_files', details: 'Searching for relevant files...', delay: 1200 },
    { action: 'read_files', details: 'Reading component files...', delay: 1000 },
    { action: 'generate_fix', details: 'Generating code fix...', delay: 2000 },
    { action: 'apply_changes', details: 'Applying changes to files...', delay: 1500 },
    { action: 'run_tests', details: 'Running test suite...', delay: 2500 },
    { action: 'verify_fix', details: 'Verifying fix resolves issue...', delay: 1000 },
    { action: 'save_changes', details: 'Committing changes...', delay: 800 }
  ];

  for (const step of steps) {
    await new Promise(resolve => setTimeout(resolve, step.delay));

    if (!sessions.has(sessionId)) return; // Session was deleted

    session.steps.push({
      ...step,
      timestamp: new Date().toISOString()
    });

    console.log(`   [${sessionId.substring(0, 8)}] ${step.action}: ${step.details}`);
  }

  session.status = 'completed';
  session.completedAt = new Date();

  console.log(`\n✅ [Mock OpenHands] Session ${sessionId} completed successfully!`);
  console.log(`   Total steps: ${session.steps.length}`);
  console.log(`   Duration: ${(session.completedAt - session.startedAt) / 1000}s`);
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mock-openhands', active_sessions: sessions.size });
});

// List all sessions (for debugging)
app.get('/api/sessions', (req, res) => {
  const sessionList = Array.from(sessions.values()).map(s => ({
    id: s.id,
    status: s.status,
    targetRepoUrl: s.targetRepoUrl,
    startedAt: s.startedAt
  }));
  res.json({ sessions: sessionList });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Mock OpenHands API Server running on http://localhost:${PORT}`);
  console.log('\nEndpoints:');
  console.log('  POST /api/run-agent     - Start a new agent session');
  console.log('  GET  /api/sessions/:id  - Get session status');
  console.log('  GET  /api/sessions/:id/logs - Get session logs');
  console.log('  GET  /health            - Health check');
  console.log('\nReady to accept requests from Autobug!\n');
});
