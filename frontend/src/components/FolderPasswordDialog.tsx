import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Eye, EyeOff, KeyRound, Loader2, X } from "lucide-react";

import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export default function FolderPasswordDialog({
  node,
  mode,
  onClose,
  onUnlocked,
  onChanged,
}: {
  node: KnowledgeTreeNode;
  mode: "unlock" | "manage";
  onClose: () => void;
  onUnlocked: (nodeId: string, unlockToken: string) => void;
  onChanged: (nodeId: string) => void;
}) {
  const protectedFolder = node.isPasswordProtected === 1;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (mode === "manage" && newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (mode === "manage" && (newPassword.length < 4 || newPassword.length > 64 || !newPassword.trim())) {
      setError("密码长度需为 4–64 个字符");
      return;
    }
    setSaving(true);
    try {
      if (mode === "unlock") {
        const result = await knowledgeTreeApi.unlockFolder(node.id, currentPassword);
        onUnlocked(node.id, result.unlockToken);
      } else {
        await knowledgeTreeApi.setFolderPassword(node.id, {
          currentPassword: protectedFolder ? currentPassword : undefined,
          newPassword,
        });
        onChanged(node.id);
      }
      onClose();
    } catch (requestError: any) {
      setError(requestError?.message || (mode === "unlock" ? "解锁失败" : "保存密码失败"));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "unlock"
    ? `解锁“${node.title}”`
    : protectedFolder ? "修改文件夹密码" : "设置文件夹密码";
  const passwordType = showPassword ? "text" : "password";

  const dialog = (
    <div className="fixed inset-0 z-[260] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={saving ? undefined : onClose} aria-label="关闭" />
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-password-dialog-title"
        className="relative w-full max-w-[380px] overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-app-border px-5 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
            <KeyRound size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="folder-password-dialog-title" className="truncate text-sm font-semibold text-tx-primary">{title}</h2>
            <p className="mt-1 text-xs leading-5 text-tx-tertiary">
              {mode === "unlock" ? "输入密码后可在本次会话中查看此文件夹。" : "密码将保护此文件夹及其全部子内容。"}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-40" aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {(mode === "unlock" || protectedFolder) && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-tx-secondary">{mode === "unlock" ? "密码" : "当前密码"}</span>
              <div className="relative">
                <input
                  autoFocus
                  type={passwordType}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  maxLength={64}
                  className="h-10 w-full rounded-xl border border-app-border bg-app-bg px-3 pr-10 text-sm text-tx-primary outline-none focus:border-accent-primary/60 focus:ring-2 focus:ring-accent-primary/10"
                />
                <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover" aria-label={showPassword ? "隐藏密码" : "显示密码"}>
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>
          )}
          {mode === "manage" && (
            <>
              <div className="flex gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-amber-700 dark:text-amber-300">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p className="text-xs leading-5">
                  密码无法找回。忘记密码后将无法进入此文件夹，请务必妥善保管。
                </p>
              </div>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-tx-secondary">{protectedFolder ? "新密码" : "密码"}</span>
                <input
                  autoFocus={!protectedFolder}
                  type={passwordType}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  maxLength={64}
                  placeholder="4–64 个字符"
                  className="h-10 w-full rounded-xl border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:border-accent-primary/60 focus:ring-2 focus:ring-accent-primary/10"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-tx-secondary">确认新密码</span>
                <input
                  type={passwordType}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                  maxLength={64}
                  className="h-10 w-full rounded-xl border border-app-border bg-app-bg px-3 text-sm text-tx-primary outline-none focus:border-accent-primary/60 focus:ring-2 focus:ring-accent-primary/10"
                />
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 text-xs leading-5 text-tx-secondary">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent-primary"
                />
                <span>我已知晓：密码遗忘后无法找回</span>
              </label>
            </>
          )}
          {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-app-border px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-lg px-3 py-2 text-xs text-tx-secondary hover:bg-app-hover disabled:opacity-40">取消</button>
          <button
            type="submit"
            disabled={saving || (mode === "unlock" ? !currentPassword : !acknowledged || !newPassword || !confirmPassword || (protectedFolder && !currentPassword))}
            className="flex min-w-20 items-center justify-center gap-1.5 rounded-lg bg-accent-primary px-4 py-2 text-xs font-medium text-white hover:bg-accent-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            {mode === "unlock" ? "解锁" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
