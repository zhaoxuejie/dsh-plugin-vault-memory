// dsh-plugin-vault-memory — 统一错误词汇
// 插件内所有面向模型/用户的失败都抛 VaultError（带稳定 code）。
// 注意：插件不 import @deepseek-ai/* 的 HarnessError（profile 无此包），
// 用普通 Error 子类 + code 属性即可满足工具错误表达。

export const VAULT_ERROR_CODES = Object.freeze({
  VAULT_NOT_CONFIGURED: "VAULT_NOT_CONFIGURED",
  VAULT_UNREADABLE: "VAULT_UNREADABLE",
  VAULT_PATH_ESCAPE: "VAULT_PATH_ESCAPE",
  VAULT_NOT_FOUND: "VAULT_NOT_FOUND",
  NOTE_NOT_FOUND: "NOTE_NOT_FOUND",
  NOTE_EXISTS: "NOTE_EXISTS",
  INDEX_NOT_READY: "INDEX_NOT_READY",
  SEARCH_FAILED: "SEARCH_FAILED",
  EMBED_UNAVAILABLE: "EMBED_UNAVAILABLE",
  INVALID_ARG: "INVALID_ARG",
  INTERNAL: "INTERNAL",
});

export class VaultError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export function vaultError(code, message, cause) {
  return new VaultError(code, message, cause);
}
