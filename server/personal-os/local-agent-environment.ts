import os from "node:os";
import { augmentedPath } from "../env-path.ts";

/** Only OS discovery, network routing and CLI config locations cross this boundary. In particular,
 * Core/provider credentials and inherited agent-session identity never do. */
export function localAgentEnvironment(source: NodeJS.ProcessEnv = process.env, searchPath = augmentedPath()): NodeJS.ProcessEnv {
  const allowed = new Set(["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "PROGRAMDATA", "ALLUSERSPROFILE", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"]);
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())));
  return { ...env, PATH: searchPath, ...(process.platform === "win32" ? {} : { HOME: env.HOME ?? os.homedir() }) };
}

