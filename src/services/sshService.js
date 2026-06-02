const { execSync } = require('child_process');
const fs = require('fs');
const encryptionService = require('./encryptionService');

// ─── Credential Resolution ───────────────────────────────────────────────────

function resolveCredentials(connectionConfig) {
  let host = process.env.SSH_HOST || '156.67.105.64';
  let user = process.env.SSH_USER || 'root';
  let password = process.env.SSH_PASSWORD || null;
  let keyPath = process.env.SSH_KEY_PATH || null;
  let timeout = parseInt(process.env.SSH_TIMEOUT_MS || '30000', 10);

  if (connectionConfig) {
    host = connectionConfig.host || connectionConfig.SSH?.host || host;
    user = connectionConfig.user || connectionConfig.SSH?.user || user;
    password = connectionConfig.password || connectionConfig.SSH?.password || password;
    keyPath = connectionConfig.keyPath || connectionConfig.SSH?.keyPath || keyPath;
    timeout = connectionConfig.timeout || connectionConfig.SSH?.timeout || timeout;
  }

  // Prefer per-vendor encrypted sshKey: write to a temp key file
  let tempKeyPath = null;
  if (connectionConfig?.sshKey) {
    try {
      const keyContent = encryptionService.decrypt(connectionConfig.sshKey);
      tempKeyPath = `/tmp/autobug_key_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      fs.writeFileSync(tempKeyPath, keyContent, { mode: 0o600 });
      keyPath = tempKeyPath;
      password = null; // prefer key auth
    } catch (err) {
      console.warn('[SSH] Failed to decrypt vendor SSH key, falling back to password');
    }
  }

  // Decrypt password if it looks encrypted (longer than typical plaintext)
  if (password && password.length > 40) {
    try {
      password = encryptionService.decrypt(password);
    } catch (err) {
      // likely not encrypted, use as-is
    }
  }

  return { host, user, password, keyPath, tempKeyPath, timeout };
}

if (process.env.SSH_STRICT_HOST_KEY !== 'yes' && process.env.SSH_STRICT_HOST_KEY !== 'true') {
  console.warn('⚠️ WARNING: SSH StrictHostKeyChecking=no is active (default). Set SSH_STRICT_HOST_KEY=yes to enable host key verification.');
}

function buildSshBase({ user, host, keyPath, password }) {
  const strictHostKeyEnv = process.env.SSH_STRICT_HOST_KEY;
  const useStrict = strictHostKeyEnv === 'yes' || strictHostKeyEnv === 'true';
  const knownHostsFile = process.env.SSH_KNOWN_HOSTS_FILE || '~/.ssh/known_hosts';
  const hostKeyOptions = useStrict
    ? `-o StrictHostKeyChecking=yes -o UserKnownHostsFile="${knownHostsFile}"`
    : `-o StrictHostKeyChecking=no`;

  if (keyPath && fs.existsSync(keyPath)) {
    return `ssh -i "${keyPath}" ${hostKeyOptions} -o IdentitiesOnly=yes -o ConnectTimeout=10 ${user}@${host}`;
  }
  if (password) {
    return `sshpass -e ssh ${hostKeyOptions} -o ConnectTimeout=10 ${user}@${host}`;
  }
  throw new Error('No SSH credentials available. Set SSH_KEY_PATH env var or vendor sshKey/sshPassword.');
}

function buildScpBase({ user, host, keyPath, password }) {
  const strictHostKeyEnv = process.env.SSH_STRICT_HOST_KEY;
  const useStrict = strictHostKeyEnv === 'yes' || strictHostKeyEnv === 'true';
  const knownHostsFile = process.env.SSH_KNOWN_HOSTS_FILE || '~/.ssh/known_hosts';
  const hostKeyOptions = useStrict
    ? `-o StrictHostKeyChecking=yes -o UserKnownHostsFile="${knownHostsFile}"`
    : `-o StrictHostKeyChecking=no`;

  if (keyPath && fs.existsSync(keyPath)) {
    return `scp -i "${keyPath}" ${hostKeyOptions} -o IdentitiesOnly=yes -o ConnectTimeout=10`;
  }
  if (password) {
    return `sshpass -e scp ${hostKeyOptions} -o ConnectTimeout=10`;
  }
  throw new Error('No SSH credentials available. Set SSH_KEY_PATH env var or vendor sshKey/sshPassword.');
}

function cleanupTempKey(tempKeyPath) {
  if (tempKeyPath && fs.existsSync(tempKeyPath)) {
    try { fs.unlinkSync(tempKeyPath); } catch (_) {}
  }
}

// ─── Direct Command Execution ────────────────────────────────────────────────

/**
 * Execute a command on a remote server via SSH.
 * Supports both key-based and password-based auth.
 * @param {string} command - Shell command to execute
 * @param {object} connectionConfig - Optional config with host, user, password, keyPath, sshKey, timeout
 * @param {number} timeoutMs - Execution timeout in ms
 * @returns {string} - Command stdout
 */
function execCommand(command, connectionConfig = null, timeoutMs = null) {
  const creds = resolveCredentials(connectionConfig);
  const timeout = timeoutMs || creds.timeout;
  const sshBase = buildSshBase(creds);

  const execOptions = {
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env }
  };
  if (creds.password) {
    execOptions.env.SSHPASS = creds.password;
  }

  try {
    const result = execSync(`${sshBase} '${command.replace(/'/g, "'\\''")}'`, execOptions);
    cleanupTempKey(creds.tempKeyPath);
    return result.trim();
  } catch (error) {
    cleanupTempKey(creds.tempKeyPath);
    const detailedMsg = error.stderr ? `${error.message}. Stderr: ${error.stderr.toString().substring(0, 200)}` : error.message;
    throw new Error(`SSH failed: ${detailedMsg.substring(0, 250)}`);
  }
}

// ─── Script Upload + Execution ───────────────────────────────────────────────

/**
 * Write a local script, upload via SCP, execute on remote, and clean up.
 * This is the legacy pattern retained for complex commands (avoids E2BIG).
 * @param {string} scriptContent - Bash script content
 * @param {object} connectionConfig - Optional SSH config
 * @param {number} timeoutMs - Execution timeout in ms
 * @returns {string} - Script stdout
 */
function writeAndExecute(scriptContent, connectionConfig = null, timeoutMs = null) {
  const creds = resolveCredentials(connectionConfig);
  const timeout = timeoutMs || creds.timeout;
  const sshBase = buildSshBase(creds);
  const scpBase = buildScpBase(creds);

  const localScript = `/tmp/autobug_cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}.sh`;
  const remoteScript = `/tmp/autobug_cmd_${Date.now()}_${Math.floor(Math.random() * 10000)}.sh`;

  const execOptions = {
    encoding: 'utf8',
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env }
  };
  if (creds.password) {
    execOptions.env.SSHPASS = creds.password;
  }

  const scpOptions = {
    stdio: 'ignore',
    timeout: 30000,
    env: { ...process.env }
  };
  if (creds.password) {
    scpOptions.env.SSHPASS = creds.password;
  }

  try {
    fs.writeFileSync(localScript, scriptContent, { mode: 0o600 });

    // SCP script to remote
    execSync(`${scpBase} ${localScript} ${creds.user}@${creds.host}:${remoteScript}`, scpOptions);
    fs.unlinkSync(localScript);

    // Run script on remote
    const result = execSync(`${sshBase} 'bash ${remoteScript} < /dev/null'`, execOptions);

    // Cleanup remote script
    try {
      execSync(`${sshBase} 'rm -f ${remoteScript}'`, { stdio: 'ignore', timeout: 10000, env: execOptions.env });
    } catch (_) {}

    cleanupTempKey(creds.tempKeyPath);
    return result.trim();
  } catch (error) {
    // Cleanup local script
    if (fs.existsSync(localScript)) {
      try { fs.unlinkSync(localScript); } catch (_) {}
    }
    // Cleanup remote script
    try {
      execSync(`${sshBase} 'rm -f ${remoteScript}'`, { stdio: 'ignore', timeout: 10000, env: execOptions.env });
    } catch (_) {}

    cleanupTempKey(creds.tempKeyPath);
    const detailedMsg = error.stderr ? `${error.message}. Stderr: ${error.stderr.toString().substring(0, 200)}` : error.message;
    throw new Error(`SSH failed: ${detailedMsg.substring(0, 250)}`);
  }
}

module.exports = {
  execCommand,
  writeAndExecute,
  resolveCredentials,
};
