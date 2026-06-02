#!/usr/bin/env node
/**
 * Claude Code Bridge
 * Connects Autobug Worker to running Claude Code instance via file-based queue
 */

const fs = require('fs');
const path = require('path');

const QUEUE_DIR = path.join(__dirname, 'tasks');
const PENDING_FILE = path.join(QUEUE_DIR, 'pending.json');
const PROCESSING_FILE = path.join(QUEUE_DIR, 'processing.json');
const COMPLETED_FILE = path.join(QUEUE_DIR, 'completed.json');

// Ensure queue directory exists
if (!fs.existsSync(QUEUE_DIR)) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

/**
 * Add task to queue (called by Autobug worker)
 */
function addTask(task) {
  const taskWithMeta = {
    ...task,
    queuedAt: new Date().toISOString(),
    queueStatus: 'PENDING'
  };

  const tasks = loadTasks(PENDING_FILE);
  tasks.push(taskWithMeta);
  saveTasks(PENDING_FILE, tasks);

  console.log(`[Bridge] Task ${task.id} added to Claude queue`);
  return taskWithMeta;
}

/**
 * Get next pending task (Claude polls this)
 */
function getNextTask() {
  const tasks = loadTasks(PENDING_FILE);
  if (tasks.length === 0) return null;

  const task = tasks[0];
  task.queueStatus = 'PROCESSING';
  task.startedAt = new Date().toISOString();

  // Move to processing
  const processing = loadTasks(PROCESSING_FILE);
  processing.push(task);
  saveTasks(PROCESSING_FILE, processing);

  // Remove from pending
  tasks.shift();
  saveTasks(PENDING_FILE, tasks);

  return task;
}

/**
 * Complete task (Claude calls this after fixing)
 */
function completeTask(taskId, result) {
  const processing = loadTasks(PROCESSING_FILE);
  const taskIndex = processing.findIndex(t => t.id === taskId);

  if (taskIndex === -1) {
    throw new Error(`Task ${taskId} not found in processing`);
  }

  const task = processing[taskIndex];
  task.queueStatus = 'COMPLETED';
  task.completedAt = new Date().toISOString();
  task.result = result;

  // Move to completed
  const completed = loadTasks(COMPLETED_FILE);
  completed.push(task);
  saveTasks(COMPLETED_FILE, completed);

  // Remove from processing
  processing.splice(taskIndex, 1);
  saveTasks(PROCESSING_FILE, processing);

  console.log(`[Bridge] Task ${taskId} completed`);
  return task;
}

/**
 * Get queue status
 */
function getStatus() {
  return {
    pending: loadTasks(PENDING_FILE).length,
    processing: loadTasks(PROCESSING_FILE).length,
    completed: loadTasks(COMPLETED_FILE).length,
    nextTask: loadTasks(PENDING_FILE)[0] || null
  };
}

/**
 * Load tasks from file
 */
function loadTasks(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Save tasks to file
 */
function saveTasks(file, tasks) {
  fs.writeFileSync(file, JSON.stringify(tasks, null, 2));
}

// CLI interface
if (require.main === module) {
  const command = process.argv[2];

  switch (command) {
    case 'status':
      console.log(JSON.stringify(getStatus(), null, 2));
      break;

    case 'next':
      const task = getNextTask();
      if (task) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log('No pending tasks');
        process.exit(1);
      }
      break;

    case 'complete':
      const taskId = process.argv[3];
      const resultFile = process.argv[4];
      if (!taskId) {
        console.error('Usage: node bridge.js complete <task-id> <result-file>');
        process.exit(1);
      }
      const result = resultFile ? fs.readFileSync(resultFile, 'utf8') : 'Completed';
      completeTask(taskId, result);
      console.log(`Task ${taskId} marked as complete`);
      break;

    default:
      console.log(`
Claude Code Bridge - Connects Autobug to running Claude instance

Commands:
  node bridge.js status       - Show queue status
  node bridge.js next         - Get next task (Claude calls this)
  node bridge.js complete <id> <result-file>  - Mark task complete

Files:
  ${PENDING_FILE}
  ${PROCESSING_FILE}
  ${COMPLETED_FILE}
      `);
  }
}

module.exports = {
  addTask,
  getNextTask,
  completeTask,
  getStatus
};
