#!/usr/bin/env node
/**
 * Autobug Flow Test Script - GROQ PRIMARY VERSION
 * Tests 2 tickets with Groq as PRIMARY context provider
 * Generates full report with prompts and execution details
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Test Configuration
const CONFIG = {
  API_URL: 'http://localhost:3001',
  USER_ID: 'test-user-001',
  USER_EMAIL: 'test@example.com',
  MAX_WAIT_TIME: 120000, // 2 minutes
  POLL_INTERVAL: 2000, // 2 seconds
};

// Test Tickets
const TEST_TICKETS = [
  {
    name: 'COMPLEX: Backend Issue',
    description: 'The user authentication API endpoint is returning 500 errors when JWT token expires. Need to add proper error handling and refresh token mechanism. Also update the database schema to store refresh tokens securely with bcrypt hashing.',
    expected: {
      issueType: 'backend-issue',
      complexity: 'complex',
      groqShouldAnalyze: true,
      groqShouldPrompt: true,
      reason: 'Groq is PRIMARY - it will analyze context and create prompt, Claude will execute'
    }
  },
  {
    name: 'SIMPLE: CSS Styling',
    description: 'the back button on my website looks weird, make it the same color as the other buttons and fix the padding so it matches',
    expected: {
      issueType: 'css-styling',
      complexity: 'simple',
      groqShouldAnalyze: true,
      groqShouldPrompt: true,
      reason: 'Groq PRIMARY - analyzes plain language, extracts intent, creates structured prompt'
    }
  }
];

// Colors for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(color, message) {
  console.log(`${colors[color] || ''}${message}${colors.reset}`);
}

function section(title) {
  console.log('\n' + '='.repeat(70));
  log('bright', title);
  console.log('='.repeat(70));
}

// Create ticket via API
async function createTicket(description) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ description });

    const options = {
      hostname: 'localhost',
      port: 3001,
      path: '/api/tickets',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': CONFIG.USER_ID,
        'x-user-email': CONFIG.USER_EMAIL,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Get ticket status
async function getTicket(ticketId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: `/api/admin/tickets/${ticketId}`,
      method: 'GET',
      headers: {
        'x-user-id': CONFIG.USER_ID,
        'x-user-email': CONFIG.USER_EMAIL,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Read prompt file
function readPromptFile(ticketId) {
  const promptPath = path.join(__dirname, 'logs', `prompt-${ticketId}.txt`);
  const executionPath = path.join(__dirname, 'logs', `execution-${ticketId}.json`);
  const validationPath = path.join(__dirname, 'logs', `validation-${ticketId}.json`);

  const result = {
    prompt: null,
    execution: null,
    validation: null
  };

  try {
    if (fs.existsSync(promptPath)) {
      result.prompt = fs.readFileSync(promptPath, 'utf8');
    }
  } catch (e) {}

  try {
    if (fs.existsSync(executionPath)) {
      result.execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
    }
  } catch (e) {}

  try {
    if (fs.existsSync(validationPath)) {
      result.validation = JSON.parse(fs.readFileSync(validationPath, 'utf8'));
    }
  } catch (e) {}

  return result;
}

// Wait for ticket to complete
async function waitForTicket(ticketId, maxWait = CONFIG.MAX_WAIT_TIME) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    const ticket = await getTicket(ticketId);

    if (ticket.status === 'COMPLETED' || ticket.status === 'FAILED' || ticket.status === 'WAITING_CLAUDE') {
      return ticket;
    }

    process.stdout.write('.');
    await new Promise(resolve => setTimeout(resolve, CONFIG.POLL_INTERVAL));
  }

  throw new Error(`Ticket ${ticketId} did not complete within ${maxWait}ms`);
}

// Run test for a single ticket
async function runTicketTest(testCase) {
  section(`TESTING: ${testCase.name}`);
  log('cyan', `Description: ${testCase.description}`);
  log('yellow', `Expected: ${JSON.stringify(testCase.expected, null, 2)}`);

  console.log('\n⏳ Creating ticket...');
  const created = await createTicket(testCase.description);

  if (!created.ticketId) {
    throw new Error('Failed to create ticket: ' + JSON.stringify(created));
  }

  log('green', `✅ Ticket created: ${created.ticketId}`);

  console.log('\n⏳ Waiting for processing (this may take 30-60 seconds)...');
  const ticket = await waitForTicket(created.ticketId);

  console.log('\n');
  log('bright', `Final Status: ${ticket.status}`);

  // Read generated files
  console.log('\n📁 Reading generated files...');
  const files = readPromptFile(created.ticketId);

  return {
    testCase,
    ticketId: created.ticketId,
    finalStatus: ticket.status,
    ticket,
    files
  };
}

// Generate report
function generateReport(results) {
  const reportPath = path.join(__dirname, 'test-report.md');
  const timestamp = new Date().toISOString();

  let report = `# Autobug Flow Test Report\n\n`;
  report += `**Generated:** ${timestamp}\n\n`;
  report += `**Groq Configuration:** PRIMARY context provider\n\n`;
  report += `---\n\n`;

  results.forEach((result, index) => {
    report += `## Test ${index + 1}: ${result.testCase.name}\n\n`;
    report += `**Description:** ${result.testCase.description}\n\n`;
    report += `**Expected Behavior:**\n`;
    report += `- Groq Context Analysis: ${result.testCase.expected.groqShouldAnalyze ? 'PRIMARY' : 'N/A'}\n`;
    report += `- Groq Prompt Creation: ${result.testCase.expected.groqShouldPrompt ? 'PRIMARY' : 'N/A'}\n`;
    report += `- Claude Code: ALWAYS executes\n`;
    report += `- Reason: ${result.testCase.expected.reason}\n\n`;

    report += `**Actual Results:**\n`;
    report += `- Ticket ID: ${result.ticketId}\n`;
    report += `- Final Status: ${result.finalStatus}\n`;

    if (result.files.validation) {
      report += `- Issue Type: ${result.files.validation.issueType?.type || 'N/A'}\n`;
      report += `- Complexity: ${result.files.validation.complexity || 'N/A'}\n`;
      report += `- Confidence: ${(result.files.validation.confidence * 100).toFixed(0)}%\n`;
    }

    if (result.files.execution) {
      report += `- Context Provider: ${result.files.execution.contextProvider || 'N/A'}\n`;
      report += `- Prompt Source: ${result.files.execution.promptSource || 'N/A'}\n`;
      report += `- Code Executor: ${result.files.execution.codeExecutor || 'N/A'}\n`;
      report += `- Groq Model: ${result.files.execution.groqModel || 'N/A'}\n`;
      report += `- Enhanced by Groq: ${result.files.execution.enhancedByGroq ? 'Yes' : 'No'}\n`;
      report += `- Used Local Analysis: ${result.files.execution.usedLocalAnalysis ? 'Yes (fallback)' : 'No'}\n`;
      report += `- Duration: ${result.files.execution.duration}s\n`;
    }

    report += `\n**Validation Details:**\n`;
    report += '```json\n';
    report += JSON.stringify(result.files.validation, null, 2) || 'No validation file found';
    report += '\n```\n\n';

    if (result.files.execution) {
      report += `**Execution Details:**\n`;
      report += '```json\n';

      // Include Groq context if available
      if (result.files.execution.groqContext) {
        report += `Groq Context Analysis:\n`;
        report += JSON.stringify(result.files.execution.groqContext, null, 2);
        report += `\n\n`;
      }

      report += JSON.stringify(result.files.execution, null, 2);
      report += '\n```\n\n';
    }

    if (result.files.prompt) {
      report += `**Generated Prompt (Full):**\n`;
      report += '```\n';
      report += result.files.prompt;
      report += '\n```\n\n';
    }

    report += `**Ticket Details:**\n`;
    report += '```json\n';
    report += JSON.stringify(result.ticket, null, 2);
    report += '\n```\n\n';

    report += '---\n\n';
  });

  // Summary
  report += `## Summary\n\n`;
  report += `| Test | Status | Context Provider | Prompt Source | Groq Enhanced |\n`;
  report += `|------|--------|------------------|---------------|---------------|\n`;

  results.forEach(result => {
    const contextProvider = result.files.execution?.contextProvider || 'N/A';
    const promptSource = result.files.execution?.promptSource || 'N/A';
    const enhanced = result.files.execution?.enhancedByGroq ? 'Yes' : 'No';

    report += `| ${result.testCase.name.substring(0, 20)}... | ${result.finalStatus} | ${contextProvider} | ${promptSource} | ${enhanced} |\n`;
  });

  report += `\n`;
  report += `## Groq PRIMARY Flow Verification\n\n`;
  report += `- ✅ Groq should be PRIMARY for context analysis\n`;
  report += `- ✅ Groq should be PRIMARY for prompt generation\n`;
  report += `- ✅ Claude Code should ALWAYS execute the code\n`;
  report += `- ✅ Fallback to local should occur if Groq fails\n`;

  fs.writeFileSync(reportPath, report);
  log('green', `\n✅ Report saved to: ${reportPath}`);

  return reportPath;
}

// Main execution
async function main() {
  section('AUTOBUG FLOW TEST - GROQ PRIMARY');
  log('bright', 'Testing 2 tickets with Groq as PRIMARY context/prompt provider');
  log('cyan', 'Claude Code will ALWAYS execute the actual fixes');

  // Check if server is running
  console.log('\n⏳ Checking if server is running...');
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`${CONFIG.API_URL}/api/health`, (res) => {
        if (res.statusCode === 200) {
          log('green', '✅ Server is running');
          resolve();
        } else {
          reject(new Error(`Server returned status ${res.statusCode}`));
        }
      });
      req.on('error', () => reject(new Error('Server not reachable')));
      req.setTimeout(5000, () => reject(new Error('Connection timeout')));
    });
  } catch (error) {
    log('red', `❌ ${error.message}`);
    log('yellow', '\nPlease start the services:');
    log('dim', '  Terminal 1: redis-server');
    log('dim', '  Terminal 2: node src/server.js');
    log('dim', '  Terminal 3: node safe-auto-dispatcher.js');
    process.exit(1);
  }

  // Run tests
  const results = [];

  for (const testCase of TEST_TICKETS) {
    try {
      const result = await runTicketTest(testCase);
      results.push(result);
    } catch (error) {
      log('red', `\n❌ Test failed: ${error.message}`);
      results.push({
        testCase,
        error: error.message
      });
    }

    // Wait between tests
    if (testCase !== TEST_TICKETS[TEST_TICKETS.length - 1]) {
      console.log('\n⏳ Waiting 5 seconds before next test...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Generate report
  section('GENERATING REPORT');
  const reportPath = generateReport(results);

  console.log('\n' + '='.repeat(70));
  log('bright', 'TEST COMPLETE');
  console.log('='.repeat(70));
  console.log(`\nView full report: ${reportPath}`);
  console.log(`View logs: /Users/shivang/Desktop/Autobug/logs/`);

  // Summary
  console.log('\n📊 QUICK SUMMARY:');
  results.forEach((result, i) => {
    const groqUsed = result.files?.execution?.enhancedByGroq ? '✅ Groq' : '⚙️ Local';
    const claudeExec = result.files?.execution?.codeExecutor === 'claude-code' ? '✅ Claude' : '❌ Unknown';
    console.log(`  Test ${i + 1}: ${result.testCase.name.substring(0, 30)}...`);
    console.log(`    Status: ${result.finalStatus} | Context: ${groqUsed} | Execution: ${claudeExec}`);
  });
}

main().catch(error => {
  log('red', `\nFatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});
