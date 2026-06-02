/**
 * Groq Context Service
 * Uses Groq for fast context understanding and prompt enhancement
 * Actual coding/fixing is ALWAYS done by Claude Code
 */

const https = require('https');

// Configuration
const CONFIG = {
  API_KEY: process.env.GROQ_API_KEY,
  API_KEY_FALLBACK: process.env.GROQ_API_KEY_FALLBACK,
  API_URL: 'api.groq.com',
  MODEL: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  MAX_TOKENS: parseInt(process.env.GROQ_MAX_TOKENS || '4096', 10),
  TEMPERATURE: parseFloat(process.env.GROQ_TEMPERATURE || '0.2'),
  TIMEOUT_MS: parseInt(process.env.GROQ_TIMEOUT_MS || '30000', 10),
  ENABLED: process.env.GROQ_ENABLED === 'true',
  FALLBACK_ON_ERROR: process.env.GROQ_FALLBACK_ON_ERROR !== 'false', // Default true
};

/**
 * Make HTTPS request to Groq API
 */
function makeGroqRequest(messages, options = {}, apiKey = null) {
  const key = apiKey || CONFIG.API_KEY;
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: options.model || CONFIG.MODEL,
      messages,
      max_tokens: options.maxTokens || CONFIG.MAX_TOKENS,
      temperature: options.temperature || CONFIG.TEMPERATURE,
      response_format: options.jsonMode ? { type: 'json_object' } : undefined,
    });

    const requestOptions = {
      hostname: CONFIG.API_URL,
      port: 443,
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: CONFIG.TIMEOUT_MS,
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(response);
          } else {
            const err = new Error(`Groq API error: ${response.error?.message || data}`);
            err.isRateLimit = (res.statusCode === 429 || (response.error?.message || '').includes('Rate limit'));
            reject(err);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Groq response: ${e.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Groq request failed: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Groq request timed out after ${CONFIG.TIMEOUT_MS}ms`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Make Groq request with automatic fallback key on rate limit
 */
async function makeGroqRequestWithFallback(messages, options = {}) {
  try {
    return await makeGroqRequest(messages, options);
  } catch (err) {
    if (err.isRateLimit && CONFIG.API_KEY_FALLBACK) {
      console.log('   🔄 Primary Groq key rate-limited, switching to fallback key...');
      return await makeGroqRequest(messages, options, CONFIG.API_KEY_FALLBACK);
    }
    throw err;
  }
}

/**
 * Analyze ticket context using Groq
 * Returns structured understanding of the issue
 */
async function analyzeContext(description, existingContext = {}) {
  if (!CONFIG.ENABLED || !CONFIG.API_KEY) {
    return { usedGroq: false, reason: 'Groq not configured' };
  }

  const messages = [
    {
      role: 'system',
      content: `You are a context analyzer for a code fix system. Your job is to understand the user's issue description and extract structured context.

You MUST return ONLY a JSON object with this structure:
{
  "userIntent": "clear statement of what user wants to achieve",
  "issueType": "css-styling|content-update|content-removal|content-addition|functionality-bug|general",
  "affectedElements": ["list of UI elements mentioned: button, navbar, header, footer, hero, etc"],
  "technicalTerms": ["extracted technical terms: CSS classes, component names, file references"],
  "userLanguage": "plain|technical - how technical is the user's description",
  "ambiguities": ["any unclear parts that need clarification"],
  "likelyTechStack": ["html", "css", "javascript", "react", "vue", "tailwind", etc],
  "filesToCheck": ["probable files that might be affected"],
  "clarifiedDescription": "rephrased, more technical version of user's request",
  "confidence": 0.0-1.0
}

IMPORTANT:
- Do NOT generate code or fixes
- Do NOT create shell commands
- Only extract and structure the context
- Rephrase vague descriptions into clear technical requirements`,
    },
    {
      role: 'user',
      content: `Analyze this issue description and extract structured context:

"${description}"`,
    },
  ];

  try {
    const response = await makeGroqRequestWithFallback(messages, { jsonMode: true });
    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from Groq');
    }

    const result = JSON.parse(content);
    return {
      usedGroq: true,
      context: result,
      model: response.model,
      usage: response.usage,
    };
  } catch (error) {
    return {
      usedGroq: false,
      reason: error.message,
      fallback: CONFIG.FALLBACK_ON_ERROR,
    };
  }
}

/**
 * Generate enhanced prompt for Claude Code using Groq context
 */
async function enhancePromptForClaude(description, groqContext, memoryContext = null) {
  if (!CONFIG.ENABLED || !CONFIG.API_KEY || !groqContext?.usedGroq) {
    return { usedGroq: false, reason: 'Groq not available' };
  }

  const messages = [
    {
      role: 'system',
      content: `You are a prompt engineer for Claude Code (Kimi/K2.5). Your job is to create clear, structured prompts that Claude can execute to fix code issues.

You MUST return ONLY a JSON object with this structure:
{
  "enhancedDescription": "clear, technical rephrasing of what needs to be done",
  "technicalRequirements": ["specific technical requirements extracted from context"],
  "searchTerms": ["keywords to search for in codebase"],
  "suggestedApproach": "high-level approach Claude should take",
  "claudePrompt": "the actual prompt to send to Claude Code - be specific and actionable",
  "filesHint": ["likely files that need modification"],
  "validationCriteria": ["how to verify the fix is correct"]
}

IMPORTANT:
- Do NOT write actual code
- Do NOT create shell commands
- Only create the PROMPT that Claude will use
- Make the prompt clear, specific, and actionable`,
    },
    {
      role: 'user',
      content: `Original user description: "${description}"

Groq context analysis: ${JSON.stringify(groqContext.context, null, 2)}

${memoryContext ? `Memory context from similar tickets: ${memoryContext}` : ''}

Create an enhanced prompt for Claude Code to process this issue.`,
    },
  ];

  try {
    const response = await makeGroqRequestWithFallback(messages, { jsonMode: true });
    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from Groq');
    }

    const result = JSON.parse(content);
    return {
      usedGroq: true,
      prompt: result,
      model: response.model,
      usage: response.usage,
    };
  } catch (error) {
    return {
      usedGroq: false,
      reason: error.message,
      fallback: CONFIG.FALLBACK_ON_ERROR,
    };
  }
}

/**
 * Get status and configuration
 */
function getStatus() {
  return {
    enabled: CONFIG.ENABLED,
    configured: !!CONFIG.API_KEY,
    model: CONFIG.MODEL,
    fallbackOnError: CONFIG.FALLBACK_ON_ERROR,
    timeout: CONFIG.TIMEOUT_MS,
    purpose: 'context-understanding-only',
  };
}

/**
 * Should we use Groq for this ticket?
 */
function shouldUseGroqForContext(validation) {
  if (!CONFIG.ENABLED || !CONFIG.API_KEY) {
    return false;
  }

  // Use Groq for all ticket types to enhance context
  // But skip for security issues as a precaution
  const issueType = validation.issueType?.type || 'general';
  if (issueType === 'security-issue') {
    return false;
  }

  return true;
}

module.exports = {
  analyzeContext,
  enhancePromptForClaude,
  getStatus,
  shouldUseGroqForContext,
  CONFIG,
};
