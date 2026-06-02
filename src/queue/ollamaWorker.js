#!/usr/bin/env node
/**
 * Ollama Worker — Clean Autobug Pipeline
 * 
 * Flow:
 *   1. Pick up ticket from BullMQ
 *   2. Groq analyzes context (non-tech user → tech context)
 *   3. Groq generates a structured prompt for Ollama
 *   4. Read relevant files from remote server (via SSH)
 *   5. Send prompt + file context to Ollama (on remote server)
 *   6. Parse Ollama's response into file changes
 *   7. Store proposed changes → status: REVIEW_PENDING (admin reviews)
 *   8. Admin approves → changes applied via SSH + git commit
 *
 * If anything fails → status: FAILED → goes to manual fix on admin panel
 */

require('dotenv').config();
const { Worker } = require('bullmq');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const prisma = require('../services/prismaClient');
const { redisConnection } = require('./agentQueue');
const { analyzeContext, enhancePromptForClaude } = require('../services/groqService');
const axios = require('axios');
const encryptionService = require('../services/encryptionService');
const sshService = require('../services/sshService');

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  SSH: {
    host: process.env.SSH_HOST || '156.67.105.64',
    user: process.env.SSH_USER || 'root',
    password: process.env.SSH_PASSWORD,
    repoPath: process.env.DEFAULT_REPO_PATH || '/var/www/adelphos_frontend',
    timeout: parseInt(process.env.SSH_TIMEOUT_MS || '30000', 10),
  },
  OLLAMA: {
    // Ollama runs on the REMOTE server — we SSH in and curl localhost
    host: '127.0.0.1',
    port: parseInt(process.env.OLLAMA_PORT || '11434', 10),
    model: process.env.OLLAMA_MODEL || 'kimi-k2.6',
    timeout: parseInt(process.env.OLLAMA_TIMEOUT_MS || '900000', 10),
  },
  LOG_DIR: path.join(__dirname, '..', '..', 'logs'),
};

// Initialize Prisma (using shared client)

// Cryptographically secure update notification to Express SSE server
async function notifyServerUpdate(ticketId) {
  try {
    const internalKey = process.env.INTERNAL_KEY;
    if (!internalKey) {
      console.warn('⚠️ INTERNAL_KEY not set — SSE notifications disabled');
      return;
    }
    const serverPort = process.env.PORT || 3001;
    await axios.post(`http://127.0.0.1:${serverPort}/api/internal/tickets/${ticketId}/update`, {}, {
      headers: {
        'x-internal-key': internalKey
      },
      timeout: 5000
    });
  } catch (e) {
    console.error(`⚠️ SECURE PIPELINE: Failed to notify server of ticket update: ${e.message}`);
  }
}

// Wrapper to update db state and trigger real-time SSE broadcasts in one step
async function updateTicket(ticketId, data) {
  const result = await prisma.ticket.update({
    where: { id: ticketId },
    data: data
  });
  await notifyServerUpdate(ticketId);
  return result;
}

if (!fs.existsSync(CONFIG.LOG_DIR)) {
  fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
}

// ─── Startup Banner ──────────────────────────────────────────────────────────

console.log('╔═══════════════════════════════════════════════════════╗');
console.log('║           AUTOBUG — OLLAMA WORKER (v2)               ║');
console.log('╠═══════════════════════════════════════════════════════╣');
console.log(`║  Ollama Model : ${CONFIG.OLLAMA.model.padEnd(38)}║`);
console.log(`║  Remote Server: ${CONFIG.SSH.user}@${CONFIG.SSH.host}${' '.repeat(Math.max(0, 23 - CONFIG.SSH.host.length))}║`);
console.log(`║  Target Repo  : ${CONFIG.SSH.repoPath.padEnd(38)}║`);
console.log(`║  Groq Context : ENABLED (primary)${' '.repeat(21)}║`);
console.log('╚═══════════════════════════════════════════════════════╝\n');

// ─── SSH Helper ──────────────────────────────────────────────────────────────

function sshExec(command, connectionConfig, timeoutMs = null) {
  return sshService.writeAndExecute(command, connectionConfig, timeoutMs);
}

// ─── Groq Context Analysis ──────────────────────────────────────────────────

async function getGroqContext(description) {
  console.log('   🤖 Groq: Analyzing ticket context...');

  const contextResult = await analyzeContext(description);

  if (!contextResult.usedGroq) {
    throw new Error(`Groq context analysis failed: ${contextResult.reason}`);
  }

  console.log(`   ✅ Groq context ready (${contextResult.model})`);
  console.log(`      Intent    : ${contextResult.context.userIntent}`);
  console.log(`      Type      : ${contextResult.context.issueType}`);
  console.log(`      Elements  : ${contextResult.context.affectedElements?.join(', ')}`);
  console.log(`      Files hint: ${contextResult.context.filesToCheck?.join(', ')}`);
  console.log(`      Confidence: ${(contextResult.context.confidence * 100).toFixed(0)}%`);

  return contextResult;
}

async function getGroqPrompt(description, groqContext, fileList) {
  console.log('   🤖 Groq: Building structured prompt for Ollama...');

  const promptResult = await enhancePromptForClaude(description, groqContext);

  if (!promptResult.usedGroq) {
    throw new Error(`Groq prompt generation failed: ${promptResult.reason}`);
  }

  console.log(`   ✅ Groq prompt ready`);
  console.log(`      Approach : ${promptResult.prompt.suggestedApproach?.substring(0, 80)}...`);
  console.log(`      Reqs     : ${promptResult.prompt.technicalRequirements?.length || 0} technical requirements`);

  return promptResult;
}

// ─── Safety Validation ───────────────────────────────────────────────────────
// Prevents catastrophic file replacements (e.g., entire HTML replaced with one link)

function validateProposedChanges(fileChanges, originalContents, truncatedFiles = new Set()) {
  const results = [];
  let hasBlocker = false;

  for (const change of fileChanges) {
    const filename = change.filename;
    const newContent = change.content;
    const originalContent = originalContents[filename];
    const validation = {
      filename,
      passed: true,
      warnings: [],
      blockers: [],
      stats: {},
    };

    // If we don't have the original, we can't validate — flag as warning
    if (!originalContent) {
      validation.warnings.push(`Original file not available for comparison — NEW FILE will be created`);
      validation.stats = { newLines: newContent.split('\n').length, newSize: newContent.length };
      results.push(validation);
      continue;
    }

    const origLines = originalContent.split('\n');
    const newLines = newContent.split('\n');
    const origSize = originalContent.length;
    const newSize = newContent.length;
    const sizeRatio = newSize / origSize;
    const lineRatio = newLines.length / origLines.length;

    validation.stats = {
      originalLines: origLines.length,
      newLines: newLines.length,
      originalSize: origSize,
      newSize: newSize,
      sizeRatio: (sizeRatio * 100).toFixed(1) + '%',
      lineRatio: (lineRatio * 100).toFixed(1) + '%',
    };

    // ── CHECK 1: Size ratio — new file is suspiciously smaller ──
    if (origSize > 200 && sizeRatio < 0.30) {
      validation.passed = false;
      validation.blockers.push(
        `DESTRUCTIVE: New file is only ${(sizeRatio * 100).toFixed(0)}% the size of the original ` +
        `(${newSize} vs ${origSize} chars). This would DESTROY most of the file content.`
      );
      hasBlocker = true;
    } else if (origSize > 200 && sizeRatio < 0.60) {
      validation.warnings.push(
        `New file is ${(sizeRatio * 100).toFixed(0)}% the size of original — significant content may be lost`
      );
    }

    // ── CHECK 2: Line count ratio ──
    if (origLines.length > 20 && newLines.length < 5) {
      validation.passed = false;
      validation.blockers.push(
        `DESTRUCTIVE: Original has ${origLines.length} lines but new version has only ${newLines.length} lines. ` +
        `Ollama likely returned a snippet instead of the complete file.`
      );
      hasBlocker = true;
    } else if (origLines.length > 20 && lineRatio < 0.40) {
      validation.warnings.push(
        `Line count dropped from ${origLines.length} to ${newLines.length} — possible content loss`
      );
    }

    // ── CHECK 3: HTML structural integrity ──
    if (filename.endsWith('.html') || filename.endsWith('.htm')) {
      const requiredTags = ['<html', '<head', '<body', '</html>', '</body>'];
      for (const tag of requiredTags) {
        const origHas = originalContent.toLowerCase().includes(tag);
        const newHas = newContent.toLowerCase().includes(tag);
        if (origHas && !newHas) {
          validation.passed = false;
          validation.blockers.push(
            `DESTRUCTIVE: Original has ${tag} but the new version is MISSING it. ` +
            `The HTML structure has been destroyed.`
          );
          hasBlocker = true;
        }
      }
    }

    // ── CHECK 4: CSS structural integrity ──
    if (filename.endsWith('.css') || filename.endsWith('.scss')) {
      const origRules = (originalContent.match(/\{/g) || []).length;
      const newRules = (newContent.match(/\{/g) || []).length;
      if (origRules > 5 && newRules < origRules * 0.3) {
        validation.passed = false;
        validation.blockers.push(
          `DESTRUCTIVE: Original has ${origRules} CSS rule blocks but new version has only ${newRules}. ` +
          `Most CSS rules have been stripped out.`
        );
        hasBlocker = true;
      }
    }

    // ── CHECK 5: Content preservation — check how many original lines survived ──
    if (origLines.length > 10) {
      const nonEmptyOrig = origLines.filter(l => l.trim().length > 10);
      const sampleSize = Math.min(20, nonEmptyOrig.length);
      let preserved = 0;

      for (let i = 0; i < sampleSize; i++) {
        const sampleIdx = Math.floor(i * nonEmptyOrig.length / sampleSize);
        const line = nonEmptyOrig[sampleIdx].trim();
        if (newContent.includes(line)) {
          preserved++;
        }
      }

      const preserveRatio = preserved / sampleSize;
      validation.stats.contentPreserved = (preserveRatio * 100).toFixed(0) + '%';

      if (preserveRatio < 0.30 && origLines.length > 20) {
        validation.passed = false;
        validation.blockers.push(
          `DESTRUCTIVE: Only ${(preserveRatio * 100).toFixed(0)}% of original content lines were found in new version. ` +
          `Most of the file content has been stripped.`
        );
        hasBlocker = true;
      } else if (preserveRatio < 0.60) {
        validation.warnings.push(
          `Only ${(preserveRatio * 100).toFixed(0)}% of original content preserved — review carefully`
        );
      }
    }

    // ── Generate diff summary for admin ──
    const addedLines = newLines.filter(l => l.trim() && !originalContent.includes(l.trim()));
    const removedLines = origLines.filter(l => l.trim() && !newContent.includes(l.trim()));
    validation.diffSummary = {
      linesAdded: addedLines.length,
      linesRemoved: removedLines.length,
      addedPreview: addedLines.slice(0, 10).map(l => '+ ' + l.trim()),
      removedPreview: removedLines.slice(0, 10).map(l => '- ' + l.trim()),
    };

    results.push(validation);
  }

  return {
    allPassed: !hasBlocker,
    results,
    summary: hasBlocker
      ? `🚫 BLOCKED — ${results.filter(r => !r.passed).length} file(s) failed safety checks (destructive changes detected)`
      : `✅ All ${results.length} file(s) passed safety checks`,
  };
}

// ─── Main Worker ─────────────────────────────────────────────────────────────

const worker = new Worker(
  'ai-agent-queue',
  async (job) => {
    const { ticketId, issueDescription, targetRepoUrl } = job.data;
    const startTime = Date.now();
    let baseCommit = null;
    let config = null;

    console.log('\n' + '═'.repeat(60));
    console.log(`🎫 TICKET: ${ticketId}`);
    console.log(`📝 "${issueDescription}"`);
    console.log('═'.repeat(60) + '\n');

    try {
      // ── Step 1: Mark as PROCESSING ──
      await updateTicket(ticketId, { status: 'PROCESSING', progress: 5 });

      // Fetch ticket with vendor and vendorConfig
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { vendor: { include: { config: true } } }
      });

      if (!ticket) {
        throw new Error('Ticket not found in database');
      }

      // ── Load Active Config from DB ──
      config = {
        SSH: { ...CONFIG.SSH },
        OLLAMA: { ...CONFIG.OLLAMA },
        BACKEND: {
          host: '',
          user: '',
          password: '',
        }
      };

      // Load global SystemConfig defaults first
      try {
        const dbConfigs = await prisma.systemConfig.findMany();
        for (const c of dbConfigs) {
          if (c.key === 'target_repo_path') {
            config.SSH.repoPath = c.value;
          } else if (c.key === 'ssh_host') {
            config.SSH.host = c.value;
          } else if (c.key === 'ssh_user') {
            config.SSH.user = c.value;
          } else if (c.key === 'ssh_password') {
            config.SSH.password = encryptionService.decrypt(c.value);
          } else if (c.key === 'ssh_backend_host') {
            config.BACKEND.host = c.value;
          } else if (c.key === 'ssh_backend_user') {
            config.BACKEND.user = c.value;
          } else if (c.key === 'ssh_backend_password') {
            config.BACKEND.password = encryptionService.decrypt(c.value);
          } else if (c.key === 'ollama_model') {
            config.OLLAMA.model = c.value;
          }
        }
      } catch (err) {
        console.log(`   ⚠️ Failed to load dynamic global config from DB: ${err.message}`);
      }

      // Override with VendorConfig if present
      if (ticket.vendor && ticket.vendor.config) {
        const vConfig = ticket.vendor.config;
        console.log(`   🏢 Resolving vendor-specific configuration for vendor: ${ticket.vendor.name}`);
        if (vConfig.repoPath) config.SSH.repoPath = vConfig.repoPath;
        if (vConfig.sshHost) config.SSH.host = vConfig.sshHost;
        if (vConfig.sshUser) config.SSH.user = vConfig.sshUser;
        if (vConfig.sshPassword) config.SSH.password = encryptionService.decrypt(vConfig.sshPassword);
        if (vConfig.sshKey) config.sshKey = encryptionService.decrypt(vConfig.sshKey);
      }

      // Resolve backend SSH settings fallback
      if (!config.BACKEND.host) {
        config.BACKEND.host = process.env.SSH_BACKEND_HOST || config.SSH.host;
      }
      if (!config.BACKEND.user) {
        config.BACKEND.user = process.env.SSH_BACKEND_USER || config.SSH.user;
      }
      if (!config.BACKEND.password) {
        config.BACKEND.password = process.env.SSH_BACKEND_PASSWORD || config.SSH.password;
      }
      if (!config.BACKEND.sshKey) {
        config.BACKEND.sshKey = config.sshKey;
      }
      console.log(`   ⚙️  Configured repo path: ${config.SSH.repoPath}`);
      console.log(`   ⚙️  Configured SSH host : ${config.SSH.host}`);
      console.log(`   ⚙️  Configured Ollama   : ${config.OLLAMA.model}`);
      
      await updateTicket(ticketId, { progress: 15 });

      // ── Step 2: Groq Context Analysis ──
      console.log('📌 STEP 1: Groq context analysis...');
      let groqContext;
      try {
        groqContext = await getGroqContext(issueDescription);
      } catch (err) {
        console.log(`   ⚠️  Groq failed: ${err.message}`);
        console.log(`   🔄 Using fallback context (Groq skipped)`);
        // Fallback: create basic context from the ticket description
        const desc = issueDescription.toLowerCase();
        const filesToCheck = ['index.html', 'style.css'];
        // Auto-detect page-specific files from description
        if (desc.includes('simulator')) { filesToCheck.push('simulator.html', 'simulator.css'); }
        if (desc.includes('calculator') || desc.includes('calc')) { filesToCheck.push('calculator.html'); }
        if (desc.includes('contact')) { filesToCheck.push('contact.html'); }
        if (desc.includes('mobile') || desc.includes('responsive')) { filesToCheck.push('simulator.css'); }
        groqContext = {
          context: {
            userIntent: issueDescription,
            issueType: desc.includes('mobile') || desc.includes('responsive') ? 'css-styling' : 'general',
            affectedElements: [],
            technicalTerms: [],
            filesToCheck: [...new Set(filesToCheck)],
            clarifiedDescription: issueDescription,
            confidence: 0.5,
          },
          model: 'fallback (Groq unavailable)',
        };
      }

      await updateTicket(ticketId, { progress: 30 });

      // ── Step 3: Groq Prompt Generation ──
      console.log('\n📌 STEP 2: Groq prompt generation...');
      let groqPrompt;
      try {
        groqPrompt = await getGroqPrompt(issueDescription, groqContext);
      } catch (err) {
        console.log(`   ⚠️  Groq prompt failed: ${err.message}`);
        console.log(`   🔄 Using fallback prompt (Groq skipped)`);
        // Fallback: create basic prompt
        groqPrompt = {
          prompt: {
            technicalRequirements: [
              'Fix the issue described by the user',
              'Ensure mobile responsiveness if mentioned',
              'Preserve all existing functionality',
            ],
            suggestedApproach: 'Read all files carefully, identify the issue, and fix it with minimal changes.',
          },
          model: 'fallback (Groq unavailable)',
        };
      }

      await updateTicket(ticketId, { progress: 45 });

      // Resolve Git Repo Link vs Local Directory Path
      const isGitUrl = config.SSH.repoPath.startsWith('http://') || 
                       config.SSH.repoPath.startsWith('https://') || 
                       config.SSH.repoPath.startsWith('git@') || 
                       config.SSH.repoPath.endsWith('.git');
      
      if (isGitUrl) {
        const slug = ticket.vendor ? ticket.vendor.slug : 'default';
        const actualRepoPath = `/opt/autobug/repos/${slug}`;
        console.log(`   📦 Target Project Location is a Git Repository URL: ${config.SSH.repoPath}`);
        console.log(`   📦 Target Local Clone Path on remote: ${actualRepoPath}`);
        
        // Check if directory exists
        const dirExistsCheck = await sshExec(`[ -d "${actualRepoPath}/.git" ] && echo "YES" || echo "NO"`, config);
        if (dirExistsCheck.trim() === 'YES') {
          console.log(`   🔄 Repository already cloned. Pulling latest updates...`);
          await sshExec(`cd ${actualRepoPath} && git stash && git pull --rebase 2>/dev/null || true`, config);
        } else {
          console.log(`   📥 Cloning repository...`);
          let cloneUrl = config.SSH.repoPath;
          const vConfig = ticket.vendor ? ticket.vendor.config : null;
          if (vConfig && vConfig.gitPat && cloneUrl.startsWith('https://')) {
            const gitPat = encryptionService.decrypt(vConfig.gitPat);
            const gitUser = vConfig.gitAuthUser || 'git';
            const urlWithoutProtocol = cloneUrl.replace('https://', '');
            await sshExec(
              `export GIT_ASKPASS=/tmp/autobug_git_askpass_${ticketId}.sh && ` +
              `echo '#!/bin/sh\\necho "${gitPat}"' > /tmp/autobug_git_askpass_${ticketId}.sh && chmod +x /tmp/autobug_git_askpass_${ticketId}.sh && ` +
              `mkdir -p /opt/autobug/repos && git clone https://${gitUser}@${urlWithoutProtocol} ${actualRepoPath} && ` +
              `rm -f /tmp/autobug_git_askpass_${ticketId}.sh`,
              config
            );
          } else {
            await sshExec(`mkdir -p /opt/autobug/repos && git clone ${cloneUrl} ${actualRepoPath}`, config);
          }
        }
        
        // Update the repoPath to the local clone path for all subsequent commands
        config.SSH.repoPath = actualRepoPath;
      }

      // ── Step 4: Initializing Git baseline ──
      console.log(`\n📌 STEP 4: Initializing Git baseline...`);
      
      // Clean any dirty state first
      await sshExec(`cd ${config.SSH.repoPath} && git add -A && git commit -m "autobug-pre-ticket-clean" 2>/dev/null || true`, config);
      baseCommit = (await sshExec(`cd ${config.SSH.repoPath} && git rev-parse HEAD`, config)).trim();
      console.log(`   Baseline commit: ${baseCommit}`);

      // ── Step 5: Self-Correction Retry Loop ──
      let finalFileChanges = null;
      let finalOriginals = null;
      let finalModifiedFiles = null;
      let finalClaudeOutput = null;
      let safetyCheck = { allPassed: false, results: [] };
      let testResult = null;
      let feedbackContext = '';
      let hasSucceeded = false;
      const MAX_RETRIES = 3;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`\n📌 STEP 5: Claude Code Generation Attempt ${attempt} of ${MAX_RETRIES}...`);
        await updateTicket(ticketId, { progress: Math.min(90, 45 + attempt * 10) });

        let prompt = `Fix the following issue in this repository.

ISSUE DESCRIPTION:
"${issueDescription}"

Groq Context Analysis:
- User Intent: ${groqContext.context.userIntent}
- Issue Type: ${groqContext.context.issueType}
- Affected Elements: ${(groqContext.context.affectedElements || []).join(', ')}
- Suggested Approach: ${groqPrompt.prompt.suggestedApproach || 'Analyze and fix the issue.'}

Technical Requirements:
${(groqPrompt.prompt.technicalRequirements || []).map((r, i) => `${i + 1}. ${r}`).join('\n')}`;

        if (attempt > 1) {
          prompt += `\n\n⚠️ PREVIOUS ATTEMPT FAILED VETTING. Please correct the issue and try again.
Feedback from previous attempt:
${feedbackContext}`;
        }

        const b64Prompt = Buffer.from(prompt).toString('base64');
        const runCmd = `cd ${config.SSH.repoPath} && ` +
          `mkdir -p /tmp/www-data-home && chown www-data:www-data /tmp/www-data-home && ` +
          `chown -R www-data:www-data ${config.SSH.repoPath} && ` +
          `echo "${b64Prompt}" | base64 -d > /tmp/autobug-prompt-${ticketId}.txt && ` +
          `chown www-data:www-data /tmp/autobug-prompt-${ticketId}.txt && ` +
          `sudo -u www-data HOME=/tmp/www-data-home ` +
          `ollama launch claude --model ${config.OLLAMA.model} --yes -- ` +
          `--dangerously-skip-permissions -p "$(cat /tmp/autobug-prompt-${ticketId}.txt)" < /dev/null 2>&1; ` +
          `EXIT_CODE=$? && ` +
          `rm -f /tmp/autobug-prompt-${ticketId}.txt && ` +
          `exit $EXIT_CODE`;

        // Start progress ticker to keep UI active
        let currentProgress = Math.min(90, 45 + attempt * 10);
        const progressTicker = setInterval(async () => {
          if (currentProgress < 90) {
            currentProgress += 1;
            try {
              await updateTicket(ticketId, { progress: currentProgress });
            } catch (e) { /* ignore */ }
          }
        }, 15000);

        let claudeOutput;
        try {
          claudeOutput = await sshExec(runCmd, config, 900000); // 15 min timeout
        } finally {
          clearInterval(progressTicker);
        }

        console.log(`   ✅ Claude Code execution finished`);
        
        // Ensure all changes are committed
        const commitMsg = `fix: ${issueDescription.substring(0, 50)} [Autobug #${ticketId.substring(0, 8)}]`;
        await sshExec(`cd ${config.SSH.repoPath} && git add -A && git commit -m "${commitMsg}" 2>/dev/null || true`, config);

        // Analyze changes
        const modifiedFilesStr = await sshExec(`cd ${config.SSH.repoPath} && git diff --name-only ${baseCommit} HEAD`, config);
        const modifiedFiles = modifiedFilesStr.split('\n').map(f => f.trim()).filter(f => f);
        console.log(`   Modified files:`, modifiedFiles);

        if (modifiedFiles.length === 0) {
          feedbackContext = `Claude Code did not make or commit any file changes. Please make sure to apply files changes matching the issue description. Output of claude: ${claudeOutput ? claudeOutput.substring(0, 1000) : ''}`;
          console.log(`   ⚠️ Attempt ${attempt} failed: no file changes made.`);
          continue;
        }

        const fileChanges = [];
        const originals = {};

        for (const file of modifiedFiles) {
          const newContent = await sshExec(`cat ${config.SSH.repoPath}/${file}`, config);
          const originalContent = await sshExec(`cd ${config.SSH.repoPath} && git show ${baseCommit}:${file} 2>/dev/null || echo "___FILE_NOT_FOUND___"`, config);
          
          fileChanges.push({
            filename: file,
            content: newContent,
            mode: 'replace',
          });
          originals[file] = originalContent === '___FILE_NOT_FOUND___' ? null : originalContent;
        }

        // Run Safety Validation
        safetyCheck = validateProposedChanges(fileChanges, originals);
        if (!safetyCheck.allPassed) {
          const blockedResults = safetyCheck.results.filter(r => !r.passed);
          feedbackContext = `Safety validation failed on the proposed changes:
${blockedResults.map(r => `- File "${r.filename}" failed checks: ${r.blockers.join('; ')}`).join('\n')}
Please ensure you only modify the necessary sections and retain the rest of the original content.`;
          console.log(`   ⚠️ Attempt ${attempt} failed safety validation. Blocker(s):`, blockedResults.map(r => r.blockers.join('; ')));
          
          // Revert to baseline commit
          await sshExec(`cd ${config.SSH.repoPath} && git reset --hard ${baseCommit} && git clean -fd`, config);
          continue;
        }

        // Run Test Command if configured
        const testCommand = (ticket.vendor && ticket.vendor.config && ticket.vendor.config.testCommand) || process.env.DEFAULT_TEST_COMMAND;
        if (testCommand) {
          console.log(`   🧪 Running test command (Attempt ${attempt}): ${testCommand}`);
          try {
            const testOutput = await sshExec(`cd ${config.SSH.repoPath} && ${testCommand}`, config);
            console.log(`   ✅ Test command passed`);
            testResult = { passed: true, command: testCommand, output: testOutput };
          } catch (testError) {
            console.log(`   ❌ Test command failed: ${testError.message}`);
            feedbackContext = `Test suite failed after applying changes.
Command: ${testCommand}
Error output:
${testError.message}`;
            testResult = { passed: false, command: testCommand, error: testError.message };
            
            // Revert to baseline commit
            await sshExec(`cd ${config.SSH.repoPath} && git reset --hard ${baseCommit} && git clean -fd`, config);
            continue;
          }
        }

        // If we got here, everything passed!
        hasSucceeded = true;
        finalFileChanges = fileChanges;
        finalOriginals = originals;
        finalModifiedFiles = modifiedFiles;
        finalClaudeOutput = claudeOutput;
        break;
      }

      if (!hasSucceeded) {
        throw new Error(`Claude Code failed to generate valid, working changes after ${MAX_RETRIES} attempts. Last feedback: ${feedbackContext}`);
      }

      // ── Step 8: Optional git push ──
      let pushResult = null;
      if (process.env.GIT_PUSH_ENABLED === 'true') {
        console.log(`   Checking remote origin for git push...`);
        try {
          const hasOrigin = await sshExec(`cd ${config.SSH.repoPath} && git remote get-url origin 2>/dev/null || echo "NO_ORIGIN"`, config);
          if (hasOrigin.trim() !== 'NO_ORIGIN') {
            console.log(`   Pushing changes to remote...`);
            pushResult = await sshExec(`cd ${config.SSH.repoPath} && git push origin HEAD`, config);
            console.log(`   ✅ Pushed successfully`);
          } else {
            console.log(`   ⚠️ No remote origin found, skipping git push.`);
          }
        } catch (pushErr) {
          console.warn(`   ⚠️ Git push failed: ${pushErr.message}`);
          pushResult = `FAILED: ${pushErr.message}`;
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      const executionData = {
        ticketId,
        duration: `${duration}s`,
        groqContext: groqContext.context,
        groqModel: groqContext.model,
        groqPrompt: groqPrompt.prompt,
        ollamaModel: config.OLLAMA.model,
        ollamaRawResponse: finalClaudeOutput,
        filesRead: finalModifiedFiles,
        filesChanged: finalModifiedFiles,
        promptSizeKB: (prompt.length / 1024).toFixed(1),
        safetyCheck: safetyCheck,
        testResult: testResult,
        gitPushResult: pushResult,
        timestamp: new Date().toISOString(),
      };

      const proposedChanges = {
        changes: finalFileChanges,
        originals: finalOriginals,
        safetyCheck: safetyCheck,
        testResult: testResult,
        gitPushResult: pushResult,
        repoPath: config.SSH.repoPath,
        generatedAt: new Date().toISOString(),
        ollamaModel: config.OLLAMA.model,
        isGitCommitted: true,
        baseCommit: baseCommit,
      };

      await updateTicket(ticketId, {
        status: 'REVIEW_PENDING',
        progress: 100,
        agentSessionId: `ollama-${ticketId.substring(0, 8)}`,
        executionJson: JSON.stringify(executionData),
        proposedChanges: JSON.stringify(proposedChanges),
      });

      console.log('\n' + '✅'.repeat(30));
      console.log('  TICKET READY FOR REVIEW!');
      console.log('✅'.repeat(30));
      console.log(`  Duration     : ${duration}s`);
      console.log(`  Files to edit: ${finalModifiedFiles.join(', ')}`);
      console.log(`  Status       : REVIEW_PENDING`);
      console.log(`  Next         : Admin reviews on dashboard → approves → code goes live`);
      console.log('═'.repeat(60) + '\n');

      return {
        success: true,
        ticketId,
        duration,
        filesChanged: finalModifiedFiles,
        status: 'REVIEW_PENDING',
      };

    } catch (error) {
      console.error(`\n❌ FAILED: ${error.message}`);

      try {
        if (baseCommit) {
          console.log(`   🔄 Reverting repository to baseline ${baseCommit}...`);
          await sshExec(`cd ${config.SSH.repoPath} && git reset --hard ${baseCommit}`, config);
        }
      } catch (e) {
        console.error(`   ⚠️  Revert failed (non-fatal): ${e.message}`);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      await updateTicket(ticketId, {
        status: 'FAILED',
        progress: 0,
        errorMessage: error.message,
        executionJson: JSON.stringify({
          ticketId,
          error: error.message,
          duration: `${duration}s`,
          timestamp: new Date().toISOString(),
        }),
      });

      console.log('   → Ticket sent to MANUAL FIX on admin panel');
      console.log('═'.repeat(60) + '\n');

      // Don't rethrow — we've handled the failure by updating DB
      // Throwing would cause BullMQ to retry, which we don't want
      return {
        success: false,
        ticketId,
        error: error.message,
        status: 'FAILED',
      };
    }
  },
  {
    connection: redisConnection,
    lockDuration: 1200000,   // 20 min lock
    lockRenewTime: 300000,   // renew every 5 min
    stalledInterval: 600000, // check stalled every 10 min
  }
);

// ─── Events ──────────────────────────────────────────────────────────────────

worker.on('ready', () => {
  console.log('✅ Ollama Worker ready — listening on ai-agent-queue\n');
});

worker.on('failed', (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err.message);
});

worker.on('completed', (job) => {
  console.log(`✅ Job ${job?.id} completed`);
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down Ollama Worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

console.log('🚀 Ollama Worker started — waiting for tickets...\n');
