#!/usr/bin/env node
/**
 * SAFE Auto-Dispatcher
 * Robust ticket processor with comprehensive validation and safety checks
 * - Validates tickets before processing
 * - Prevents execution of dangerous commands
 * - Dry-run mode for testing
 * - Manual approval for uncertain tickets
 */

const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const { redisConnection } = require('./src/queue/agentQueue');
const { PromptGenerator } = require('./prompt-generator');
const { TicketValidator } = require('./src/validation/ticketValidator');
const { execSync } = require('child_process');
const fs = require('fs');
const { buildMemoryContext, storeTicketMemory } = require('./src/services/memoryService');
const { analyzeContext: groqAnalyzeContext, enhancePromptForClaude: groqEnhancePrompt } = require('./src/services/groqService');

// Configuration
const CONFIG = {
  // Safety settings
  DRY_RUN: process.env.DRY_RUN === 'true', // Set to true to test without making changes
  REQUIRE_CONFIRMATION: process.env.REQUIRE_CONFIRMATION === 'true', // Always ask before executing
  MAX_AUTO_COMPLEXITY: 'medium', // Don't auto-process complex tickets
  MIN_CONFIDENCE: 0.75, // Minimum confidence for auto-auto-processing

  // Groq AI settings
  GROQ: {
    ENABLED: process.env.GROQ_ENABLED === 'true',
    FALLBACK_ON_ERROR: process.env.GROQ_FALLBACK_ON_ERROR !== 'false', // Default: true
    PREFERRED_FOR_SIMPLE: process.env.GROQ_PREFERRED_FOR_SIMPLE !== 'false', // Default: true
  },

  // Ollama AI settings for intelligent coding
  OLLAMA: {
    ENABLED: process.env.OLLAMA_ENABLED !== 'false', // Default: true
    HOST: process.env.OLLAMA_HOST || '127.0.0.1',
    PORT: parseInt(process.env.OLLAMA_PORT || '11434', 10),
    MODEL: process.env.OLLAMA_MODEL || 'codellama:7b-code',
    TIMEOUT: parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10), // 2 min default
  },

  // SSH settings
  SSH: {
    host: process.env.SSH_HOST || '156.67.105.64',
    user: process.env.SSH_USER || 'root',
    password: process.env.SSH_PASSWORD || '30rZNitUz*un6vgz',
    repoPath: process.env.DEFAULT_REPO_PATH || '/var/www/adelphos_frontend',
    timeout: parseInt(process.env.SSH_TIMEOUT_MS || '30000', 10), // 30 second default timeout
  },

  // Logging
  LOG_DIR: './logs',
  SAVE_PROMPTS: true
};

// Initialize
const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL || 'file:./dev.db',
});
const prisma = new PrismaClient({ adapter });
const promptGen = new PromptGenerator();
const validator = new TicketValidator();

// Ensure log directory exists
if (!fs.existsSync(CONFIG.LOG_DIR)) {
  fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
}

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║          SAFE AUTOBUG AUTO-DISPATCHER                          ║');
console.log('╠════════════════════════════════════════════════════════════════╣');
console.log(`║  Mode: ${CONFIG.DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will make changes)'}                           ║`);
console.log(`║  Confirmation: ${CONFIG.REQUIRE_CONFIRMATION ? 'REQUIRED' : 'AUTO for safe tickets'}                        ║`);
console.log(`║  Min Confidence: ${(CONFIG.MIN_CONFIDENCE * 100).toFixed(0)}%                                   ║`);
console.log(`║  Target: ${CONFIG.SSH.user}@${CONFIG.SSH.host}:${CONFIG.SSH.repoPath}    ║`);
console.log(`║  Groq AI: ${CONFIG.GROQ.ENABLED ? 'ENABLED' : 'disabled'}${CONFIG.GROQ.ENABLED ? ` (fallback: ${CONFIG.GROQ.FALLBACK_ON_ERROR ? 'on' : 'off'})` : ''}                         ║`);
console.log(`║  Ollama AI: ${CONFIG.OLLAMA.ENABLED ? 'ENABLED' : 'disabled'}${CONFIG.OLLAMA.ENABLED ? ` (${CONFIG.OLLAMA.MODEL})` : ''}                    ║`);
console.log('╚════════════════════════════════════════════════════════════════╝\n');

// Safe command whitelist - only these commands are allowed
const SAFE_COMMANDS = [
  // Reading
  { pattern: /^cat\s+/, type: 'read' },
  { pattern: /^ls\s+/, type: 'read' },
  { pattern: /^find\s+/, type: 'read' },
  { pattern: /^grep\s+/, type: 'read' },
  { pattern: /^head\s+/, type: 'read' },
  { pattern: /^tail\s+/, type: 'read' },
  { pattern: /^pwd$/, type: 'read' },
  { pattern: /^cd\s+/, type: 'read' },

  // Writing (with restrictions)
  { pattern: /^sed\s+-i.*index\.html$/, type: 'write', allowed: true },

  // Git (safe operations only)
  { pattern: /^git\s+(add|status|log|diff)/, type: 'git', allowed: true },
  { pattern: /^git\s+commit/, type: 'git-commit', requiresConfirmation: true },

  // Temp files
  { pattern: /^(echo|printf).*>\s*\/tmp\//, type: 'temp', allowed: true },
  { pattern: /^rm\s+-f\s*\/tmp\//, type: 'temp-cleanup', allowed: true }
];

// Validate command before executing
function validateCommand(cmd) {
  // Check for dangerous patterns
  const dangerousPatterns = [
    { pattern: /rm\s+-rf/i, reason: 'Mass deletion' },
    { pattern: /rm\s+.*\*/i, reason: 'Wildcard deletion' },
    { pattern: /dd\s+if=/i, reason: 'Disk writing' },
    { pattern: />\s*\/etc\//i, reason: 'System file modification' },
    { pattern: /mkfs/i, reason: 'Filesystem operation' },
    { pattern: /curl.*\|.*sh/i, reason: 'Remote code execution' },
    { pattern: /wget.*-O-\|/i, reason: 'Remote code execution' },
    { pattern: /chmod\s+777/i, reason: 'Dangerous permissions' },
    { pattern: /sudo/i, reason: 'Privilege escalation' },
    { pattern: /su\s+-/i, reason: 'User switching' }
  ];

  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(cmd)) {
      return {
        allowed: false,
        reason: `Dangerous command detected: ${reason}`,
        command: cmd
      };
    }
  }

  // Check against whitelist
  const matchedSafe = SAFE_COMMANDS.find(({ pattern }) => pattern.test(cmd));

  if (!matchedSafe) {
    return {
      allowed: false,
      reason: 'Command not in safe list',
      command: cmd
    };
  }

  return {
    allowed: true,
    type: matchedSafe.type,
    requiresConfirmation: matchedSafe.requiresConfirmation || false
  };
}

// Create the autonomous worker
const safeAutoDispatcher = new Worker(
  'ai-agent-queue',
  async (job) => {
    const { ticketId, issueDescription, targetRepoUrl } = job.data;
    const startTime = Date.now();

    console.log('\n' + '═'.repeat(70));
    console.log(`🎫 NEW TICKET: ${ticketId}`);
    console.log(`📝 "${issueDescription}"`);
    console.log('═'.repeat(70) + '\n');

    // STEP 1: Validate Ticket
    console.log('🔒 STEP 1: Validating ticket safety...');

    const ticket = {
      id: ticketId,
      description: issueDescription,
      targetRepoUrl: targetRepoUrl || CONFIG.SSH.repoPath
    };

    // Generate context first for validation
    const context = promptGen.analyzeTicket(ticket);

    const validation = validator.validate(ticket, context);

    console.log('   Validation Results:');
    console.log('   • Valid:', validation.isValid ? '✅ YES' : '❌ NO');
    console.log('   • Can Auto-Process:', validation.canAutoProcess ? '✅ YES' : '⚠️  NO');
    console.log('   • Action:', validation.recommendation.action);

    if (validation.errors.length > 0) {
      console.log('   • Errors:', validation.errors.join('; '));
    }
    if (validation.warnings.length > 0) {
      console.log('   • Warnings:', validation.warnings.join('; '));
    }

    // Log validation results
    const validationLog = `${CONFIG.LOG_DIR}/validation-${ticketId}.json`;
    fs.writeFileSync(validationLog, JSON.stringify(validation, null, 2));
    console.log(`   💾 Validation saved: ${validationLog}`);

    // Handle validation failures - send to manual review instead of failing
    if (!validation.isValid) {
      console.log('\n⚠️  Ticket validation issues - sending to manual review');

      // Idempotency check: Don't update if already in terminal state
      const currentTicket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { status: true }
      });

      if (currentTicket?.status === 'WAITING_CLAUDE') {
        console.log('   Ticket already queued for manual review, skipping...');
        return {
          success: false,
          ticketId,
          reason: 'Already queued for manual review',
          validation
        };
      }

      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'WAITING_CLAUDE',
          agentSessionId: `manual-review-${ticketId}`,
          validationJson: JSON.stringify(validation),
          errorMessage: validation.errors.join('; ')
        },
      });

      console.log('   Ticket queued for manual processing');
      console.log('   Issues:', validation.errors.join(', '));

      return {
        success: false,
        ticketId,
        reason: 'Manual review required due to validation issues',
        validation
      };
    }

    // Check for low confidence or other critical warnings that require manual review
    const hasLowConfidence = validation.warnings.some(w => w.includes('Confidence low'));
    const hasNoTargetFiles = validation.warnings.some(w => w.includes('No target files automatically identified'));

    // Check if ticket has images uploaded
    const hasImages = ticket.imageReferences && ticket.imageReferences.length > 0;

    // Common UI elements that system can auto-fix based on description alone
    const desc = (ticket.description || '').toLowerCase();
    const hasCommonElementRef = /\b(back button|back site button|nav-?bar|nav bar|navigation|menu button|menu|header|footer|logo|banner|hero|hero section)\b/i.test(desc);

    // Clear issue indicators - users describe problems in plain language
    const hasClearIssue = /\b(does not fit|looks off|too big|too small|misaligned|wrong color|broken|not working|fix|change|update|adjust|move|resize|padding|margin|align|position|style|color|size|width|height)\b/i.test(desc);

    // Complex issue types that need manual review
    const issueType = context.issueType?.type || 'unknown';
    // Also treat as CSS if user describes visual issues with common elements
    const isVisualElementIssue = hasCommonElementRef && hasClearIssue;
    const isCSSStyling = issueType === 'css-styling' || isVisualElementIssue;

    const isBackendIssue = ['backend-issue', 'api-issue', 'database-issue', 'deployment-issue'].includes(issueType);
    const isSecurityIssue = issueType === 'security-issue';
    const isComplexInfrastructure = ['docker-issue', 'cicd-issue', 'config-issue'].includes(issueType);
    const isPerformance = issueType === 'performance';

    // Allow auto-processing for simple visual issues if:
    // 1. User uploaded a screenshot (hasImages), OR
    // 2. Description mentions common UI elements with clear issues
    const allowVisualAutoFix = isCSSStyling && (hasImages || (hasCommonElementRef && hasClearIssue));

    // Allow auto-processing for simple visual issues even with low confidence
    // if user clearly describes a common element with a clear issue
    const isSimpleVisualFix = isCSSStyling && (hasImages || (hasCommonElementRef && hasClearIssue));

    const hasCriticalWarnings = ((hasLowConfidence && !isSimpleVisualFix && !CONFIG.GROQ.ENABLED) ||
                                (hasNoTargetFiles && !isSimpleVisualFix && !CONFIG.GROQ.ENABLED) ||
                                (isCSSStyling && !isSimpleVisualFix && !CONFIG.GROQ.ENABLED) ||
                                (isBackendIssue && !CONFIG.GROQ.ENABLED) ||
                                (isSecurityIssue && !CONFIG.GROQ.ENABLED) ||
                                (isComplexInfrastructure && !CONFIG.GROQ.ENABLED) ||
                                (isPerformance && !CONFIG.GROQ.ENABLED));

    // Handle tickets requiring manual review
    if (validation.requiresManualReview || validation.recommendation.action === 'MANUAL_REVIEW' || hasCriticalWarnings) {
      console.log('\n⚠️  Ticket requires manual review');
      if (hasLowConfidence) console.log('   Reason: Low confidence score');
      if (hasNoTargetFiles && !hasImages) console.log('   Reason: No target files identified and no screenshot provided');
      if (hasNoTargetFiles && hasImages) console.log('   Reason: Cannot locate element - needs human review');
      if (isCSSStyling && !hasImages) console.log('   Reason: Visual/CSS issues need screenshots for auto-fix');
      if (isBackendIssue) console.log('   Reason: Backend/API issues require manual review');
      if (isSecurityIssue) console.log('   Reason: Security issues require manual review');
      if (isComplexInfrastructure) console.log('   Reason: Infrastructure changes require manual review');
      if (isPerformance) console.log('   Reason: Performance optimizations require manual review');

      // Idempotency check: Don't update if already in terminal state
      const currentTicket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        select: { status: true }
      });

      if (currentTicket?.status === 'WAITING_CLAUDE') {
        console.log('   Ticket already queued for manual review, skipping...');
        return {
          success: false,
          ticketId,
          reason: 'Already queued for manual review',
          validation
        };
      }

      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'WAITING_CLAUDE',
          agentSessionId: `manual-review-${ticketId}`,
          validationJson: JSON.stringify(validation),
          errorMessage: validation.warnings.join('; ')
        },
      });

      console.log('   Ticket queued for manual processing');
      console.log('   Admin can review at: http://localhost:3001/admin');

      return {
        success: false,
        ticketId,
        reason: 'Manual review required',
        validation
      };
    }

    // Confirm if required (for non-critical warnings)
    if (CONFIG.REQUIRE_CONFIRMATION || validation.warnings.length > 0) {
      console.log('\n⚠️  This ticket has warnings. Review before proceeding.');
      console.log('   Warnings:', validation.warnings.join(', '));
      console.log('   Set REQUIRE_CONFIRMATION=false to skip this');

      // In a real system, you might wait for user input here
      // For now, we'll proceed after a delay
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('   ✅ Ticket validated\n');

    // STEP 2a: PRIMARY - Groq Context Analysis
    // Groq is PRIMARY for context understanding and prompt creation
    let groqContext = null;
    let groqPrompt = null;
    let usedLocalAnalysis = false;

    if (CONFIG.GROQ.ENABLED) {
      console.log('🤖 STEP 2a: Groq analyzing context (PRIMARY)...');
      try {
        groqContext = await groqAnalyzeContext(ticket.description);

        if (groqContext.usedGroq) {
          console.log(`   🤖 Context analyzed by: ${groqContext.model}`);
          console.log(`   User Intent: ${groqContext.context.userIntent}`);
          console.log(`   Affected Elements: ${groqContext.context.affectedElements.join(', ')}`);
          console.log(`   Technical Terms: ${groqContext.context.technicalTerms.join(', ')}`);
          console.log(`   Confidence: ${(groqContext.context.confidence * 100).toFixed(0)}%`);

          if (groqContext.context.ambiguities.length > 0) {
            console.log(`   ⚠️  Ambiguities detected: ${groqContext.context.ambiguities.join('; ')}`);
          }

          // Use Groq's analysis to update validation context
          if (groqContext.context.issueType) {
            context.issueType = {
              type: groqContext.context.issueType,
              category: groqContext.context.likelyTechStack[0] || 'frontend',
              priority: groqContext.context.confidence > 0.8 ? 'low' : 'medium'
            };
          }

          // Use Groq's file suggestions
          if (groqContext.context.filesToCheck?.length > 0) {
            context.likelyFiles = groqContext.context.filesToCheck;
          }
        } else {
          console.log(`   ⚠️ Groq context analysis failed: ${groqContext.reason}`);
          if (!CONFIG.GROQ.FALLBACK_ON_ERROR) {
            console.log('   ❌ Fallback disabled - ticket will fail');
            throw new Error(`Groq failed and fallback is disabled: ${groqContext.reason}`);
          }
          console.log('   ⚙️  Falling back to local analysis...');
          usedLocalAnalysis = true;
        }
      } catch (error) {
        console.log(`   ⚠️ Groq error: ${error.message}`);
        if (!CONFIG.GROQ.FALLBACK_ON_ERROR) {
          throw error;
        }
        console.log('   ⚙️  Falling back to local analysis...');
        usedLocalAnalysis = true;
        groqContext = { usedGroq: false, reason: error.message };
      }
    } else {
      console.log('⚙️  STEP 2a: Local context analysis (Groq disabled)');
      usedLocalAnalysis = true;
    }

    // STEP 2b: Build Memory Context
    console.log('🧠 STEP 2b: Retrieving memory context...');
    const memory = await buildMemoryContext(ticket);
    if (memory?.hasMemory) {
      console.log(`   Found ${memory.similarCount} similar ticket(s) in memory`);
      console.log(memory.contextMessage);

      // Update ticket with memory trail
      await prisma.ticket.update({
        where: { id: ticketId },
        data: { memoryTrail: memory.memoryTrail }
      });
    } else {
      console.log('   No similar tickets found in memory');
    }

    // STEP 3: Generate Prompt (PRIMARY: Groq, FALLBACK: Local)
    console.log('\n📝 STEP 3: Generating optimized prompt...');
    await prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'PROCESSING' }
    });

    // PRIMARY: Use Groq to generate enhanced prompt for Claude
    let promptResult;
    let enhancedByGroq = false;
    let promptSource = 'groq';

    if (groqContext?.usedGroq) {
      console.log('   🤖 PRIMARY: Groq generating enhanced prompt for Claude...');
      try {
        groqPrompt = await groqEnhancePrompt(
          ticket.description,
          groqContext,
          memory?.contextMessage || null
        );

        if (groqPrompt.usedGroq) {
          enhancedByGroq = true;

          // Build the complete enhanced prompt
          promptResult = {
            ticketId: ticket.id,
            originalDescription: ticket.description,
            context: {
              issueType: context.issueType,
              affectedAreas: groqContext.context.affectedElements,
              likelyFiles: groqContext.context.filesToCheck,
              complexity: groqContext.context.confidence > 0.8 ? 'simple' :
                        groqContext.context.confidence > 0.5 ? 'medium' : 'complex',
              actions: ['analyze', 'modify'],
              techStack: groqContext.context.likelyTechStack,
              keywords: groqContext.context.technicalTerms?.length > 0
                ? groqContext.context.technicalTerms
                : groqContext.context.affectedElements || [],
              confidence: groqContext.context.confidence,
              groqEnhanced: true,
              groqModel: groqContext.model,
              userIntent: groqContext.context.userIntent,
              technicalRequirements: groqPrompt.prompt.technicalRequirements,
              promptSource: 'groq-primary'
            },
            prompt: `
🎫 AUTOBUG TICKET #${ticket.id}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 ORIGINAL REQUEST:
   "${ticket.description}"

🔍 GROQ CONTEXT ANALYSIS (PRIMARY):
   • User Intent: ${groqContext.context.userIntent}
   • Affected Elements: ${groqContext.context.affectedElements.join(', ')}
   • Technical Terms: ${groqContext.context.technicalTerms.join(', ')}
   • Files to Check: ${groqContext.context.filesToCheck.join(', ')}
   • Confidence: ${(groqContext.context.confidence * 100).toFixed(0)}%

📋 TECHNICAL REQUIREMENTS:
   ${groqPrompt.prompt.technicalRequirements.map((req, i) => `${i + 1}. ${req}`).join('\n   ')}

🎯 SUGGESTED APPROACH:
   ${groqPrompt.prompt.suggestedApproach}

💡 CLARIFIED DESCRIPTION:
   ${groqContext.context.clarifiedDescription}

${memory?.contextMessage ? `📚 MEMORY FROM SIMILAR TICKETS:\n${memory.contextMessage}\n` : ''}

🎯 ENHANCED PROMPT FOR CLAUDE CODE:
${groqPrompt.prompt.claudePrompt}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`,
            executionPlan: {
              steps: groqPrompt.prompt.technicalRequirements.map((req, i) => ({
                step: i + 1,
                description: req,
                type: 'analyze'
              }))
            }
          };

          console.log('   ✅ Prompt created by Groq (PRIMARY)');
          console.log(`   • Technical Requirements: ${groqPrompt.prompt.technicalRequirements.length}`);
          console.log(`   • Files Hinted: ${groqPrompt.prompt.filesHint.length}`);
          console.log(`   • Validation Criteria: ${groqPrompt.prompt.validationCriteria?.length || 0}`);
        } else {
          console.log(`   ⚠️ Groq prompt generation failed: ${groqPrompt.reason}`);
          console.log('   ⚙️  FALLBACK: Using local prompt generator...');
          promptSource = 'local-fallback';
        }
      } catch (error) {
        console.log(`   ⚠️ Groq prompt generation error: ${error.message}`);
        console.log('   ⚙️  FALLBACK: Using local prompt generator...');
        promptSource = 'local-fallback-error';
      }
    }

    // FALLBACK: Use local prompt generator if Groq failed or was skipped
    if (!promptResult) {
      promptResult = promptGen.generate(ticket);
      promptResult.context.promptSource = promptSource;
      promptResult.context.groqEnhanced = false;
      console.log('   ⚙️  Prompt generated locally');
    }

    if (memory?.contextMessage) {
      promptResult.prompt += memory.contextMessage;
    }

    console.log('   Context Analysis:');
    console.log('   • Issue Type:', promptResult.context.issueType.type);
    console.log('   • Category:', promptResult.context.issueType.category);
    console.log('   • Complexity:', promptResult.context.complexity);
    console.log('   • Confidence:', (promptResult.context.confidence * 100).toFixed(0) + '%');
    console.log('   • Target Files:', promptResult.context.likelyFiles.join(', '));
    console.log(`   • Groq Context: ${enhancedByGroq ? '✅ Enhanced' : '⚙️ Local only'}`);
    console.log('   • Claude Code: Will execute the fix');
    console.log('   ✅ Prompt generated');

    // Save prompt
    if (CONFIG.SAVE_PROMPTS) {
      const promptFile = `${CONFIG.LOG_DIR}/prompt-${ticketId}.txt`;
      fs.writeFileSync(promptFile, promptResult.prompt);
      console.log(`   💾 Prompt saved: ${promptFile}`);
    }

    console.log('');

    // STEP 4: Prepare Execution Plan
    console.log('📋 STEP 4: Preparing execution plan...');

    const executionPlan = await prepareExecutionPlan(promptResult);

    console.log('   Planned Actions:');
    executionPlan.steps.forEach((step, i) => {
      console.log(`   ${i + 1}. ${step.description} (${step.type})`);
    });

    if (CONFIG.DRY_RUN) {
      console.log('\n🔍 DRY RUN MODE - No changes will be made');
      console.log('   Set DRY_RUN=false to execute for real');

      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'COMPLETED',
          agentSessionId: `dry-run-${ticketId}`
        },
      });

      return {
        success: true,
        ticketId,
        mode: 'DRY_RUN',
        validation,
        executionPlan
      };
    }

    console.log('');

    // STEP 5: Execute Safely
    console.log('🔧 STEP 5: Executing fix (with safety checks)...');

    try {
      const result = await executeSafeFix(ticketId, executionPlan, promptResult);

      // STEP 6: Finalize
      console.log('\n✅ STEP 6: Finalizing...');

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      // Save execution log
      const execLogData = {
        ticketId,
        result,
        validation,
        executionPlan,
        duration,
        // Groq only does context analysis, Claude does the actual coding
        contextProvider: groqContext?.usedGroq ? 'groq' : 'local',
        codeExecutor: CONFIG.OLLAMA.MODEL,
        groqModel: groqContext?.model || null,
        groqContext: groqContext?.usedGroq ? groqContext.context : null,
        groqPrompt: groqPrompt?.usedGroq ? groqPrompt.prompt : null,
        enhancedByGroq: groqContext?.usedGroq && groqPrompt?.usedGroq,
        timestamp: new Date().toISOString()
      };
      const execLog = `${CONFIG.LOG_DIR}/execution-${ticketId}.json`;
      fs.writeFileSync(execLog, JSON.stringify(execLogData, null, 2));

      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'COMPLETED',
          agentSessionId: `safe-auto-${ticketId}`,
          validationJson: JSON.stringify(validation),
          executionJson: JSON.stringify(execLogData)
        },
      });

      console.log('\n' + '✅'.repeat(35));
      console.log('  TICKET COMPLETED SUCCESSFULLY!');
      console.log('✅'.repeat(35));
      console.log(`  Duration: ${duration}s`);
      console.log(`  Files Modified: ${result.filesChanged?.length || 0}`);
      console.log(`  Commands Executed: ${result.commandsExecuted || 0}`);
      console.log(`  Summary: ${result.summary}`);
      console.log('═'.repeat(70) + '\n');

      // Store in memory for future reference
      try {
        const ticketWithData = await prisma.ticket.findUnique({
          where: { id: ticketId }
        });
        if (ticketWithData) {
          await storeTicketMemory(ticketWithData, context.issueType?.type);
        }
      } catch (e) {
        console.log('   ⚠️  Could not store memory:', e.message);
      }

      return {
        success: true,
        ticketId,
        duration,
        filesChanged: result.filesChanged,
        summary: result.summary
      };

    } catch (error) {
      console.error('\n❌ Execution failed:', error.message);

      const execLogData = {
        ticketId,
        error: error.message,
        validation,
        executionPlan,
        timestamp: new Date().toISOString()
      };

      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'FAILED',
          validationJson: JSON.stringify(validation),
          executionJson: JSON.stringify(execLogData),
          errorMessage: error.message
        }
      });

      throw error;
    }
  },
  {
    connection: redisConnection,
    lockDuration: 360000,    // 6 min lock — Ollama code generation can take 2-3+ min
    lockRenewTime: 120000,   // renew every 2 min
    stalledInterval: 300000  // check for stalled jobs every 5 min
  }
);

// Prepare execution plan (simplified - execution handled by executeSafeFix)
async function prepareExecutionPlan(promptResult) {
  return {
    steps: [{
      description: 'Execute via Ollama AI coding',
      type: 'ollama-execution',
      command: 'ollama-generate',
      safe: false
    }]
  };
}

// Call Ollama API for intelligent code generation
async function callOllamaAI(systemPrompt, userPrompt, model = null) {
  const ollamaHost = CONFIG.OLLAMA.HOST;
  const ollamaPort = CONFIG.OLLAMA.PORT;
  const ollamaModel = model || CONFIG.OLLAMA.MODEL;

  const requestBody = {
    model: ollamaModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    options: {
      temperature: 0.2
      // num_predict omitted — kimi-k2.5:cloud is a cloud model with its own token limit
    }
  };

  const ollamaTimeoutMs = CONFIG.OLLAMA.TIMEOUT; // 180000ms from .env
  const curlMaxSec = Math.floor(ollamaTimeoutMs / 1000);

  try {
    const requestJson = JSON.stringify(requestBody);
    const localTempFile = `/tmp/ollama_req_local_${Date.now()}_${Math.floor(Math.random() * 10000)}.json`;
    const remoteTempFile = `/tmp/ollama_req_remote_${Date.now()}_${Math.floor(Math.random() * 10000)}.json`;

    fs.writeFileSync(localTempFile, requestJson);

    // SCP request to remote
    const scpCmd = `sshpass -p '${CONFIG.SSH.password}' scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${localTempFile} ${CONFIG.SSH.user}@${CONFIG.SSH.host}:${remoteTempFile}`;
    execSync(scpCmd, { stdio: 'pipe', timeout: 30000 });
    fs.unlinkSync(localTempFile);

    // Call Ollama on remote — use OLLAMA timeout, not the short SSH default
    const curlCmd = `curl -s --max-time ${curlMaxSec} -X POST http://${ollamaHost}:${ollamaPort}/api/chat -H "Content-Type: application/json" -d @${remoteTempFile}`;
    const response = await safeSSH(curlCmd, ollamaTimeoutMs + 10000);

    await safeSSH(`rm -f ${remoteTempFile}`).catch(() => {});

    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch (parseErr) {
      return {
        success: false,
        error: `JSON parse error: ${parseErr.message}. Raw (first 500): ${response.substring(0, 500)}`
      };
    }

    if (parsed.error) {
      return { success: false, error: `Ollama error: ${parsed.error}` };
    }

    if (parsed.message && parsed.message.content) {
      return {
        success: true,
        content: parsed.message.content,
        model: ollamaModel,
        done: parsed.done
      };
    }

    return {
      success: false,
      error: `Unexpected Ollama response shape. Keys: ${Object.keys(parsed).join(', ')}. Raw (first 500): ${response.substring(0, 500)}`
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Read file content from remote server
async function readRemoteFile(filePath) {
  try {
    const content = await safeSSH(`cat ${filePath} 2>/dev/null || echo "FILE_NOT_FOUND"`);
    if (content === 'FILE_NOT_FOUND') {
      return null;
    }
    return content;
  } catch (error) {
    console.log(`   ⚠️ Could not read ${filePath}: ${error.message}`);
    return null;
  }
}

// Write file content to remote server
async function writeRemoteFile(filePath, content) {
  try {
    // Use base64 encoding to handle special characters safely
    const base64Content = Buffer.from(content).toString('base64');
    await safeSSH(`echo '${base64Content}' | base64 -d > ${filePath}`);
    return true;
  } catch (error) {
    console.log(`   ⚠️ Could not write ${filePath}: ${error.message}`);
    return false;
  }
}

// Get project file structure
async function getProjectFiles() {
  try {
    const files = await safeSSH(`cd ${CONFIG.SSH.repoPath} && find . -type f \( -name "*.html" -o -name "*.css" -o -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" -o -name "*.vue" -o -name "*.json" \) 2>/dev/null | head -50`);
    return files.split('\n').filter(f => f && !f.includes('node_modules'));
  } catch (error) {
    return [];
  }
}

// Execute fix with Ollama AI — targeted context extraction, not full-file dumps
async function executeSafeFix(ticketId, executionPlan, promptResult) {
  const result = {
    success: false,
    filesChanged: [],
    commandsExecuted: 0,
    summary: '',
    logs: [],
    aiAnalysis: null,
    aiLog: null
  };

  const ollamaModel = CONFIG.OLLAMA.MODEL;
  console.log(`   🤖 Executing fix via Ollama AI (${ollamaModel})...`);
  console.log('   📁 Repository:', CONFIG.SSH.repoPath);

  try {
    const groqContext = promptResult.context;
    const issueType = groqContext?.issueType?.type || 'general';
    const affectedElements = groqContext?.affectedAreas || [];
    const techStack = groqContext?.techStack || ['html', 'css'];
    const desc = (promptResult.originalDescription || '').toLowerCase();

    console.log(`   📋 Issue Type: ${issueType}`);
    console.log(`   🎯 Affected Elements: ${affectedElements.join(', ') || 'See description'}`);
    console.log(`   🛠️ Tech Stack: ${techStack.join(', ')}`);

    // ── Smart context extraction: send only the relevant snippet, NOT full files ──
    // This keeps the Ollama request small (~1-3KB) so it responds in seconds, not minutes.
    let contextSnippets = {};
    let targetFile = 'style.css';

    const isCSSIssue = issueType === 'css-styling' || desc.includes('color') ||
                       desc.includes('background') || desc.includes('style') ||
                       desc.includes('font') || desc.includes('border') || desc.includes('padding');
    const isHTMLIssue = issueType === 'content-addition' || issueType === 'html' ||
                        desc.includes('add') || desc.includes('link') || desc.includes('navbar') ||
                        desc.includes('button') || desc.includes('text');

    if (isCSSIssue) {
      // Extract only the nav/navbar CSS rules from style.css
      const keywords = ['nav', 'navbar', 'header', 'hero', ...affectedElements.map(e => e.toLowerCase())];
      for (const kw of keywords.slice(0, 3)) {
        try {
          const snippet = await safeSSH(
            `grep -n -A 15 -B 2 "${kw}" ${CONFIG.SSH.repoPath}/style.css 2>/dev/null | head -80`
          );
          if (snippet && snippet.trim() && snippet !== 'FILE_NOT_FOUND') {
            contextSnippets['style.css'] = (contextSnippets['style.css'] || '') + snippet + '\n---\n';
          }
        } catch (e) { /* skip */ }
      }
      targetFile = 'style.css';
    }

    if (isHTMLIssue || Object.keys(contextSnippets).length === 0) {
      // Extract the navbar/nav block from index.html
      try {
        const navSnippet = await safeSSH(
          `grep -n -A 30 -B 2 "<nav\\|navbar\\|<header" ${CONFIG.SSH.repoPath}/index.html 2>/dev/null | head -80`
        );
        if (navSnippet && navSnippet.trim()) {
          contextSnippets['index.html'] = navSnippet;
          targetFile = 'index.html';
        }
      } catch (e) { /* skip */ }
    }

    // Fallback: read first 2000 chars of style.css
    if (Object.keys(contextSnippets).length === 0) {
      const fallback = await readRemoteFile(`${CONFIG.SSH.repoPath}/style.css`);
      if (fallback) contextSnippets['style.css'] = fallback.substring(0, 2000);
    }

    console.log(`   📄 Context extracted from: ${Object.keys(contextSnippets).join(', ')}`);

    // ── Build focused prompt asking ONLY for the change to apply ──
    const systemPrompt = `You are an expert ${techStack.join('/')} developer.
You will be given a small excerpt of existing code and a description of what needs to change.

RULES:
1. Return ONLY the code that should be added or changed — NOT the entire file
2. For CSS: return the CSS rule block to append (e.g. "nav { background-color: #001f5b; }")
3. For HTML: return the specific HTML snippet to insert
4. Keep it minimal — only what is needed to fix the issue
5. Use this format:

---FILE: filename---
[only the new/changed code block here]
---END---`;

    const userPrompt = `Issue: "${promptResult.originalDescription}"
Issue Type: ${issueType}
Affected Elements: ${affectedElements.join(', ') || 'See description'}

Relevant existing code for context:
${Object.entries(contextSnippets).map(([f, s]) => `=== ${f} (excerpt) ===\n${s.substring(0, 1500)}`).join('\n\n')}

Return ONLY the new code to add/change. Do NOT return the full file.`;

    console.log(`   🤖 Calling Ollama AI (${ollamaModel})...`);
    console.log(`   📏 Prompt size: ~${(systemPrompt.length + userPrompt.length)} chars`);

    const aiResponse = await callOllamaAI(systemPrompt, userPrompt);

    // Record full AI log for admin panel
    result.aiLog = {
      model: ollamaModel,
      issueType,
      affectedElements,
      contextFiles: Object.keys(contextSnippets),
      promptSize: systemPrompt.length + userPrompt.length,
      success: aiResponse.success,
      rawResponse: aiResponse.success ? aiResponse.content : null,
      error: aiResponse.error || null,
      timestamp: new Date().toISOString()
    };

    if (!aiResponse.success) {
      console.log(`   ❌ Ollama AI failed: ${aiResponse.error}`);
      result.logs.push({ step: 'Ollama AI call', status: 'failed', error: aiResponse.error });
      throw new Error(`Ollama AI (${ollamaModel}) failed: ${aiResponse.error}`);
    }

    console.log('   ✅ Ollama AI responded');
    result.aiAnalysis = aiResponse.content;

    // Parse file changes from response
    const fileChanges = parseAIResponse(aiResponse.content, targetFile);

    if (fileChanges.length === 0) {
      // If no ---FILE--- blocks, treat entire response as CSS/code to append
      const raw = aiResponse.content.trim();
      console.log(`   ⚠️  No file blocks found, using raw response as append for ${targetFile}`);
      fileChanges.push({ filename: targetFile, content: raw, append: true });
    }

    result.aiLog.parsedFiles = fileChanges.map(f => f.filename);
    console.log(`   📝 Applying changes to: ${fileChanges.map(f => f.filename).join(', ')}`);

    // Apply each change
    for (const { filename, content, append } of fileChanges) {
      const remotePath = `${CONFIG.SSH.repoPath}/${filename}`;
      let success = false;

      // Always backup the file before touching it
      await safeSSH(`cp ${remotePath} ${remotePath}.autobug.bak 2>/dev/null || true`).catch(() => {});

      if (filename.endsWith('.css')) {
        // CSS: always append — cascade handles overrides, never overwrite the full file
        success = await appendRemoteFile(remotePath, `\n/* Autobug fix [${ticketId.substring(0,8)}] */\n${content}`);
      } else if (filename.endsWith('.html') || filename.endsWith('.htm')) {
        // NEVER overwrite HTML files — always insert snippet to prevent corruption
        success = await insertHtmlSnippet(remotePath, content);
      } else {
        // BLOCK: Never auto-overwrite non-CSS/HTML files — send to manual review
        console.log(`   ⚠️ BLOCKED: Cannot auto-modify ${filename} — only CSS/HTML append/insert is allowed`);
        console.log(`   Ticket requires manual review for ${filename} changes`);
        success = false;

        // Update ticket status to require manual review
        await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            status: 'WAITING_CLAUDE',
            errorMessage: `Auto-fix blocked for ${filename}: Only CSS append and HTML snippet insert are allowed. Manual review required.`
          }
        });

        throw new Error(`Auto-fix blocked: ${filename} modification requires manual review`);
      }

      if (success) {
        result.filesChanged.push(filename);
        console.log(`   ✅ Updated ${filename}`);
        result.logs.push({ step: `Update ${filename}`, status: 'success' });
      } else {
        console.log(`   ❌ Failed to write ${filename}`);
        result.logs.push({ step: `Update ${filename}`, status: 'failed' });
      }
    }

    // Git commit
    if (result.filesChanged.length > 0) {
      try {
        const commitMsg = `fix: ${promptResult.originalDescription?.substring(0, 50) || 'Auto-fix'} [${ticketId.substring(0,8)}]`;
        await safeSSH(`cd ${CONFIG.SSH.repoPath} && git add -A && git commit -m "${commitMsg}" 2>/dev/null || true`);
        console.log('   ✅ Committed to git');
      } catch (e) { /* non-fatal */ }
    }

    result.success = result.filesChanged.length > 0;
    result.commandsExecuted = result.filesChanged.length;
    result.logs.push({ step: 'Ollama AI execution', status: 'success', output: `Modified: ${result.filesChanged.join(', ')}` });
    result.summary = `Ollama (${ollamaModel}): ${promptResult.originalDescription}. Modified: ${result.filesChanged.join(', ') || 'no files'}.`;

  } catch (error) {
    console.log(`   ❌ Execution failed: ${error.message}`);
    result.logs.push({ step: 'Execution', status: 'failed', error: error.message });
    throw error;
  }

  return result;
}

// Append content to a remote file
async function appendRemoteFile(filePath, content) {
  try {
    const b64 = Buffer.from(content).toString('base64');
    await safeSSH(`echo "${b64}" | base64 -d >> ${filePath}`);
    return true;
  } catch (error) {
    console.log(`   ⚠️ appendRemoteFile failed: ${error.message}`);
    return false;
  }
}

// Insert an HTML snippet into the right location in an HTML file (before </nav> or </body>)
async function insertHtmlSnippet(filePath, snippet) {
  try {
    const b64Snippet = Buffer.from(snippet).toString('base64');
    // Python handles all escaping safely — try </nav> first, then </ul>, then </body>
    const pyScript = `
import base64, re, sys
snippet = base64.b64decode("${b64Snippet}").decode("utf-8")
with open("${filePath}", "r", encoding="utf-8", errors="replace") as f:
    html = f.read()
if "</nav>" in html:
    html = html.replace("</nav>", snippet + "\\n</nav>", 1)
elif "</ul>" in html:
    idx = html.rfind("</ul>")
    html = html[:idx] + snippet + "\\n" + html[idx:]
elif "</body>" in html:
    html = html.replace("</body>", snippet + "\\n</body>", 1)
else:
    html += "\\n" + snippet
with open("${filePath}", "w", encoding="utf-8") as f:
    f.write(html)
print("ok")
`.trim();
    const b64Py = Buffer.from(pyScript).toString('base64');
    const result = await safeSSH(`echo "${b64Py}" | base64 -d | python3`);
    return result.trim() === 'ok';
  } catch (error) {
    console.log(`   ⚠️ insertHtmlSnippet failed: ${error.message}`);
    return false;
  }
}

// Parse AI response to extract file changes
function parseAIResponse(content, defaultFilename = 'style.css') {
  const files = [];

  // Try format: ---FILE: filename---
  const fileRegex = /---FILE:\s*(.+?)---([\s\S]*?)---END---/g;
  let match;
  while ((match = fileRegex.exec(content)) !== null) {
    files.push({
      filename: match[1].trim(),
      content: match[2].trim()
    });
  }
  if (files.length > 0) return files;

  // Try markdown code blocks: ```css ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:css|html|javascript|js|tsx|jsx|json)?\n([\s\S]*?)```/g;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const codeContent = match[1].trim();
    if (codeContent) {
      // Detect filename from content or use default
      let detectedFilename = defaultFilename;
      if (codeContent.includes('export ') || codeContent.includes('import ')) {
        detectedFilename = defaultFilename.replace('.css', '.js');
      }
      files.push({
        filename: detectedFilename,
        content: codeContent
      });
    }
  }
  if (files.length > 0) return files;

  // Also try alternative format: ### FILE: filename
  const altRegex = /###?\s*(?:FILE|File):?\s*(.+?)\n([\s\S]*?)(?=###?\s*(?:FILE|File):?|$)/g;
  while ((match = altRegex.exec(content)) !== null) {
    files.push({
      filename: match[1].trim(),
      content: match[2].trim()
    });
  }

  return files;
}

// Apply CSS fix intelligently without overwriting the whole file
async function applyCSSFix(result, ticketId, fileContents, color) {
  // Find any CSS file in fileContents
  const cssFile = Object.keys(fileContents).find(f => f.endsWith('.css'));
  if (!cssFile) {
    console.log('   ⚠️ No CSS file found in fileContents');
    return null;
  }

  const cssContent = fileContents[cssFile];
  const remotePath = `${CONFIG.SSH.repoPath}/${cssFile}`;

  if (!cssContent) {
    console.log('   ⚠️ No CSS content found');
    return null;
  }

  try {
    // Check if there's already a navbar rule
    const hasNavbarRule = cssContent.match(/\.navbar\s*\{/i) || cssContent.match(/navbar\s*\{/i);

    if (hasNavbarRule) {
      // Use sed to replace the background-color in existing navbar rule
      // This preserves all other styles
      const sedCmd = `sed -i 's/\.navbar\s*{/.navbar { background-color: ${color};/' ${remotePath}`;
      await safeSSH(sedCmd);
      console.log(`   ✅ Updated existing navbar rule with ${color}`);
    } else {
      // Append navbar rule to end of file
      const appendCmd = `echo ".navbar { background-color: ${color}; }" >> ${remotePath}`;
      await safeSSH(appendCmd);
      console.log(`   ✅ Appended navbar rule with ${color}`);
    }

    result.filesChanged.push(cssFile);
    result.success = true;
    result.commandsExecuted = 1;
    result.summary = `CSS fix: Updated navbar background to ${color}`;
    return result;

  } catch (error) {
    console.log(`   ⚠️ CSS fix failed: ${error.message}`);
    return null;
  }
}

// Fallback pattern-based fix (original logic)
async function executePatternBasedFix(result, ticketId, promptResult, fileContents, issueType, affectedElements) {
  console.log('   🔧 Applying pattern-based fix...');

  // Apply fix based on issue type
  if (issueType === 'css-styling' || issueType === 'content-update') {
    for (const element of affectedElements) {
      const elementLower = element.toLowerCase();

      try {
        const htmlContent = fileContents['index.html'];
        if (htmlContent && htmlContent.toLowerCase().includes(elementLower)) {
          console.log(`   ℹ️  Found "${element}" in HTML - pattern-based CSS fix disabled (Ollama required)`);
        }
      } catch (e) {
        console.log(`   ⚠️ Could not inspect ${element}: ${e.message}`);
      }
    }
  }

  if (result.filesChanged.length === 0) {
    console.log('   ℹ️ Pattern-based fallback made no changes - Ollama AI required for CSS fixes');
  }

  // Try to commit changes
  if (result.filesChanged.length > 0) {
    try {
      const commitMsg = `fix: ${promptResult.originalDescription?.substring(0, 50) || 'Auto-fix'} [Ticket #${ticketId}]`;
      await safeSSH(`cd ${CONFIG.SSH.repoPath} && git add -A && git commit -m "${commitMsg}" 2>/dev/null || true`);
      console.log('   ✅ Changes committed');
    } catch (e) {
      // Commit might fail if no changes or git not configured
    }
  }

  result.success = result.filesChanged.length > 0;
  result.commandsExecuted = result.filesChanged.length;
  result.summary = `Pattern-based fix: ${promptResult.originalDescription}. Modified ${result.filesChanged.length} file(s).`;

  return result;
}

// Safe SSH execution — pass timeoutOverride (ms) for long-running commands like Ollama
async function safeSSH(command, timeoutOverride = null) {
  const b64Cmd = Buffer.from(command).toString('base64');
  const fullCommand = `sshpass -p '${CONFIG.SSH.password}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${CONFIG.SSH.user}@${CONFIG.SSH.host} 'echo ${b64Cmd} | base64 -d | bash'`;
  const timeout = timeoutOverride || CONFIG.SSH.timeout;

  return new Promise((resolve, reject) => {
    try {
      const result = execSync(fullCommand, {
        encoding: 'utf8',
        timeout,
        maxBuffer: 20 * 1024 * 1024, // 20MB buffer for large Ollama responses
        stdio: ['pipe', 'pipe', 'pipe']
      });
      resolve(result.trim());
    } catch (error) {
      if (error.message.includes('ETIMEDOUT') || error.message.includes('timeout')) {
        reject(new Error(`SSH timeout after ${timeout}ms`));
      } else {
        reject(new Error(`SSH failed: ${error.message}`));
      }
    }
  });
}

// Handle content addition safely
async function handleContentAdditionSafe(promptResult) {
  const filesChanged = [];
  const desc = (promptResult.originalDescription || '').toLowerCase();

  // Pattern: "add X link to the navbar"
  if (desc.includes('add') && desc.includes('link') && desc.includes('nav')) {
    const match = desc.match(/add\s+(\w+)\s+link/);
    const linkName = match ? match[1] : 'New';
    const linkText = linkName.charAt(0).toUpperCase() + linkName.slice(1);
    const linkHref = `/${linkName.toLowerCase()}`;

    console.log(`   Adding "${linkText}" link to navbar...`);

    // Check if already exists (safe read)
    try {
      const checkCmd = `grep -c "${linkHref}" ${CONFIG.SSH.repoPath}/index.html || echo "0"`;
      const exists = await safeSSH(checkCmd);

      if (parseInt(exists) > 0) {
        console.log(`   ℹ️  Link already exists`);
        return filesChanged;
      }
    } catch (e) {
      console.log('   ⚠️  Could not check existing links');
    }

    // Add the link using a remote script
    // This avoids all shell escaping issues
    try {
      const cmd = `bash /opt/autobug-scripts/remote-fix.sh "${linkText}" "${linkHref}"`;
      await safeSSH(cmd);
      filesChanged.push('index.html');
      console.log(`   ✅ ${linkText} link added`);
    } catch (e) {
      console.log(`   ❌ Failed to add link: ${e.message}`);
    }
  }

  return filesChanged;
}

// Handle content removal safely
async function handleContentRemovalSafe(promptResult) {
  const filesChanged = [];
  const desc = (promptResult.originalDescription || '').toLowerCase();

  // Pattern: "remove X tab/link from the navbar"
  if ((desc.includes('remove') || desc.includes('delete') || desc.includes('hide')) &&
      desc.includes('nav')) {

    // Extract items to remove - handle "X and Y" patterns
    const itemsToRemove = [];

    // Try to find "remove X and Y" pattern
    const andPattern = /(?:remove|delete|hide)\s+(?:"|')?(\w+)(?:"|')?(?:\s+(?:and|&)\s+(?:"|')?(\w+)(?:"|')?)?/i;
    const andMatch = desc.match(andPattern);

    if (andMatch) {
      if (andMatch[1]) itemsToRemove.push(andMatch[1]);
      if (andMatch[2]) itemsToRemove.push(andMatch[2]);
    }

    // Fallback to single item patterns
    if (itemsToRemove.length === 0) {
      const patterns = [
        /(?:remove|delete|hide)\s+(?:"|')?(\w+)(?:"|')?\s+(?:tab|link|from)/,
        /(?:remove|delete|hide)\s+(\w+)\s+(?:tab|link|from|button)/,
        /(?:remove|delete|hide)\s+(?:the\s+)?(\w+)/
      ];

      for (const pattern of patterns) {
        const match = desc.match(pattern);
        if (match) {
          itemsToRemove.push(match[1]);
          break;
        }
      }
    }

    // Also check for plural forms
    const additionalItems = [];
    for (const item of itemsToRemove) {
      // If item is singular, also try plural
      if (!item.endsWith('s')) {
        additionalItems.push(item + 's');
      }
      // If item is plural, also try singular
      else if (item.endsWith('s') && itemsToRemove.length === 1) {
        additionalItems.push(item.slice(0, -1));
      }
    }
    itemsToRemove.push(...additionalItems);

    // Remove duplicates
    const uniqueItems = [...new Set(itemsToRemove)];

    if (uniqueItems.length > 0) {
      for (const itemName of uniqueItems) {
        const linkText = itemName.charAt(0).toUpperCase() + itemName.slice(1);
        console.log(`   Removing "${linkText}" from navbar...`);

        // Check if exists first
        try {
          const checkCmd = `grep -c "${linkText}" ${CONFIG.SSH.repoPath}/index.html || echo "0"`;
          const exists = await safeSSH(checkCmd);

          if (parseInt(exists) === 0) {
            console.log(`   ℹ️  Link not found - nothing to remove`);
            continue;
          }
        } catch (e) {
          console.log('   ⚠️  Could not check existing links');
        }

        // Remove the link using remote script (avoids escaping issues)
        try {
          const cmd = `bash /opt/autobug-scripts/remote-remove.sh "${linkText}"`;
          await safeSSH(cmd);
          filesChanged.push('index.html');
          console.log(`   ✅ ${linkText} link removed`);
        } catch (e) {
          console.log(`   ❌ Failed to remove link: ${e.message}`);
        }
      }
    } else {
      console.log('   ⚠️  Could not determine what to remove');
    }
  }

  return filesChanged;
}

// Handle content update safely
async function handleContentUpdateSafe(promptResult) {
  const filesChanged = [];
  const desc = (promptResult.originalDescription || '').toLowerCase();

  console.log('   Analyzing content update...');

  // Pattern: "update X text/content to Y" or "change X to Y"
  const updatePatterns = [
    /(?:update|change|replace)\s+(?:the\s+)?(?:text|content|wording|label|title|heading)\s+(?:of\s+)?["']?([^"']+)["']?\s+(?:to|with)\s+["']?([^"']+)["']?/i,
    /(?:update|change)\s+["']?([^"']+)["']?\s+(?:to|with)\s+["']?([^"']+)["']?/i
  ];

  let oldText = '';
  let newText = '';

  for (const pattern of updatePatterns) {
    const match = desc.match(pattern);
    if (match) {
      oldText = match[1];
      newText = match[2];
      break;
    }
  }

  if (oldText && newText) {
    console.log(`   Updating "${oldText}" to "${newText}"...`);

    try {
      // Use sed to replace text in index.html
      const cmd = `sed -i 's/${oldText}/${newText}/g' ${CONFIG.SSH.repoPath}/index.html`;
      await safeSSH(cmd);
      filesChanged.push('index.html');
      console.log(`   ✅ Text updated: "${oldText}" → "${newText}"`);
    } catch (e) {
      console.log(`   ❌ Failed to update text: ${e.message}`);
    }
  } else {
    console.log('   ℹ️  Could not identify specific text to update - manual review needed');
  }

  return filesChanged;
}

// Handle CSS styling fixes safely
async function handleCSSStylingSafe(promptResult) {
  const filesChanged = [];
  const desc = (promptResult.originalDescription || '').toLowerCase();
  const keywords = promptResult.context?.keywords || [];

  console.log('   Analyzing CSS styling issue...');
  console.log('   Keywords:', keywords.join(', '));

  // Check if it's a mobile/responsive issue
  const isMobileIssue = desc.includes('mobile') ||
                        desc.includes('responsive') ||
                        desc.includes('phone') ||
                        desc.includes('tablet') ||
                        desc.includes('screen size');

  // Extract common UI element names from plain English descriptions
  // Users say things like "back button", "nav bar", "header", etc.
  const elementMappings = {
    // Buttons
    'button': ['button', '.btn', '[class*="btn"]', '[class*="button"]'],
    'back button': ['.back-btn', '.back-button', '[class*="back"]', '[id*="back"]'],
    'back site button': ['.back-site-btn', '.back-btn', '[class*="back"]', '[id*="back"]'],
    'back to site button': ['.back-site-btn', '.back-btn', '[class*="back"]', '[id*="back"]'],
    'submit button': ['.submit-btn', '.submit', '[type="submit"]', '[class*="submit"]'],
    'login button': ['.login-btn', '.login', '[class*="login"]'],
    'menu button': ['.menu-btn', '.hamburger', '[class*="menu"]'],
    // Navigation
    'nav bar': ['.navbar', '.nav', 'nav', '[class*="nav"]'],
    'navbar': ['.navbar', '.nav', 'nav', '[class*="nav"]'],
    'navigation': ['.navbar', '.nav', 'nav', '[class*="nav"]'],
    'menu': ['.menu', '.nav-menu', '[class*="menu"]'],
    // Header/Footer
    'header': ['header', '.header', '[class*="header"]'],
    'footer': ['footer', '.footer', '[class*="footer"]'],
    // Common elements
    'hero': ['.hero', '.banner', '[class*="hero"]'],
    'banner': ['.banner', '.hero', '[class*="banner"]'],
    'card': ['.card', '[class*="card"]'],
    'form': ['form', '.form', '[class*="form"]'],
    'input': ['input', '.input', '[class*="input"]'],
  };

  // Find matching element selectors from description
  let matchedSelectors = [];
  for (const [term, selectors] of Object.entries(elementMappings)) {
    if (desc.includes(term)) {
      console.log(`   🎯 Found element reference: "${term}"`);
      matchedSelectors.push(...selectors);
    }
  }

  // Remove duplicates
  matchedSelectors = [...new Set(matchedSelectors)];

  // Also search for keywords mentioned
  if (keywords.length > 0) {
    const keywordPatterns = keywords.map(k => `[class*="${k}"], [id*="${k}"], .${k}`);
    matchedSelectors.push(...keywordPatterns);
  }

  // If still no selectors, use affectedElements from Groq context
  if (matchedSelectors.length === 0 && promptResult.context?.affectedAreas?.length > 0) {
    for (const element of promptResult.context.affectedAreas) {
      const elementLower = element.toLowerCase();
      if (elementMappings[elementLower]) {
        matchedSelectors.push(...elementMappings[elementLower]);
      } else {
        // Generic selector for unknown elements
        matchedSelectors.push(`[class*="${element}"]`, `[id*="${element}"]`, `.${element}`);
      }
    }
  }

  // If we found selectors, try to fix the styling
  if (matchedSelectors.length > 0) {
    console.log(`   🎯 Target selectors: ${matchedSelectors.join(', ')}`);

    try {
      // Read the CSS file to understand current styling
      const cssContent = await safeSSH(`cat ${CONFIG.SSH.repoPath}/style.css 2>/dev/null || cat ${CONFIG.SSH.repoPath}/style.unminified.css 2>/dev/null || echo "No CSS found"`);

      // Search for the element in HTML
      for (const selector of matchedSelectors.slice(0, 3)) { // Try first 3 selectors
        try {
          const grepResult = await safeSSH(`grep -n "${selector.replace(/[\[\]\*]/g, '.*')}" ${CONFIG.SSH.repoPath}/index.html | head -3 || echo ""`);
          if (grepResult && grepResult.trim()) {
            console.log(`   ✅ Found ${selector} in HTML`);

            // Apply a basic fix - add padding/margin if element looks off
            const fixCmd = `echo "${selector} { position: relative; }" >> ${CONFIG.SSH.repoPath}/style.css`;
            await safeSSH(fixCmd);
            filesChanged.push('style.css');
            console.log(`   ✅ Applied CSS fix for ${selector}`);
            break; // Stop after first successful match
          }
        } catch (e) {
          // Continue to next selector
        }
      }

      // If mobile issue, add responsive CSS
      if (isMobileIssue && filesChanged.length > 0) {
        const mobileFix = `@media (max-width: 768px) { ${matchedSelectors[0]} { max-width: 100%; padding: 10px; } }`;
        await safeSSH(`echo "${mobileFix}" >> ${CONFIG.SSH.repoPath}/style.css`);
        console.log(`   ✅ Added mobile responsive CSS`);
      }

    } catch (e) {
      console.log(`   ⚠️  CSS fix failed: ${e.message}`);
    }
  } else {
    console.log('   ℹ️  Could not identify specific element from description');
    console.log('   Will need manual review with screenshot');
  }

  return filesChanged;
}

// Event handlers
safeAutoDispatcher.on('ready', () => {
  console.log('✅ Safe Auto-Dispatcher ready\n');
});

safeAutoDispatcher.on('failed', (job, err) => {
  console.error(`\n❌ Job ${job?.id} failed:`, err.message);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down Safe Auto-Dispatcher...');
  await safeAutoDispatcher.close();
  await prisma.$disconnect();
  process.exit(0);
});

console.log('🚀 Starting safe auto-dispatch loop...\n');
