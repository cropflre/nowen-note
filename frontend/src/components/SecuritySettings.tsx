import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, Key, Loader2, CheckCircle2, Eye, EyeOff, User } from "lucide-react";

export default function SecuritySettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [shake, setShake] = useState(false);

  const triggerShake = (msg: string) => {
    setError(msg);
    setShake(true);
    setTimeout(() => setShake(false), 500);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!currentPassword) {
      return triggerShake("必须提供当前密码");
    }
    if (!newPassword && !newUsername) {
      return triggerShake("请填写要修改的用户名或新密码");
    }
    if (newPassword && newPassword.length < 6) {
      return triggerShake("新密码长度不能少于6位");
    }
    if (newPassword && newPassword !== confirmPassword) {
      return triggerShake("两次输入的新密码不一致");
    }

    setIsLoading(true);

    try {
      const token = localStorage.getItem("nowen-token");
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ currentPassword, newUsername: newUsername || undefined, newPassword: newPassword || undefined }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "更新失败");
      }

      setSuccess(true);
      setTimeout(() => {
        localStorage.removeItem("nowen-token");
        window.location.reload();
      }, 2000);
    } catch (err: any) {
      triggerShake(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-1">账号与安全</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">修改用户名或密码需验证当前密码</p>
      </div>

      <motion.form
        onSubmit={handleSubmit}
        className="space-y-4 max-w-md"
        animate={shake ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : { x: 0 }}
        transition={shake ? { duration: 0.5 } : {}}
      >
        {/* 当前密码 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            当前密码 <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Key className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
            </div>
            <input
              type={showCurrentPassword ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={`block w-full pl-10 pr-10 py-2.5 border rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm ${
                error && !currentPassword ? "border-red-500/50 dark:border-red-500/50" : "border-zinc-200 dark:border-zinc-700"
              }`}
              placeholder="输入当前密码以验证身份"
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              onClick={() => setShowCurrentPassword(!showCurrentPassword)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            >
              {showCurrentPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        {/* 分割线 */}
        <div className="h-px w-full bg-zinc-200 dark:bg-zinc-800" />

        {/* 新用户名 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">新用户名 (可选)</label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <User className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
            </div>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="block w-full pl-10 pr-3 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm"
              placeholder="留空则不修改"
              autoComplete="username"
            />
          </div>
        </div>

        {/* 新密码 */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">新密码 (可选)</label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Key className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
            </div>
            <input
              type={showNewPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="block w-full pl-10 pr-10 py-2.5 border border-zinc-200 dark:border-zinc-700 rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm"
              placeholder="至少6位，留空则不修改"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowNewPassword(!showNewPassword)}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            >
              {showNewPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        {/* 确认新密码 */}
        <AnimatePresence>
          {newPassword && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="space-y-1.5 overflow-hidden"
            >
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">确认新密码</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Key className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
                </div>
                <input
                  type={showNewPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={`block w-full pl-10 pr-3 py-2.5 border rounded-xl bg-zinc-50/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 dark:focus:border-indigo-500 transition-all text-sm ${
                    confirmPassword && newPassword !== confirmPassword ? "border-red-500/50 dark:border-red-500/50" : "border-zinc-200 dark:border-zinc-700"
                  }`}
                  placeholder="再次输入新密码"
                  autoComplete="new-password"
                  required={!!newPassword}
                />
              </div>
              {confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs text-red-500 dark:text-red-400">两次输入的密码不一致</p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* 错误提示 */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 提交按钮 */}
        <button
          type="submit"
          disabled={isLoading || success}
          className={`w-full flex items-center justify-center py-2.5 px-4 rounded-xl text-sm font-medium text-white transition-all shadow-sm hover:shadow-md ${
            success
              ? "bg-green-500"
              : "bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-500"
          } disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:focus:ring-offset-zinc-900`}
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : success ? (
            <>
              <CheckCircle2 className="w-4 h-4 mr-2" />
              修改成功，请重新登录...
            </>
          ) : (
            <>
              <Key className="w-4 h-4 mr-2" />
              保存安全设置
            </>
          )}
        </button>
      </motion.form>
    </div>
  );
}
