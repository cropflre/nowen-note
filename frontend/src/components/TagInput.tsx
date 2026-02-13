import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Hash, Plus } from "lucide-react";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { Tag } from "@/types";

interface TagInputProps {
  noteId: string;
  noteTags: Tag[];
  onTagsChange?: (tags: Tag[]) => void;
}

export default function TagInput({ noteId, noteTags, onTagsChange }: TagInputProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const [inputValue, setInputValue] = useState("");
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [isFocused, setIsFocused] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isAdding, setIsAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // 过滤联想词
  useEffect(() => {
    if (inputValue.trim()) {
      const filtered = state.tags.filter(
        (t) =>
          t.name.toLowerCase().includes(inputValue.toLowerCase()) &&
          !noteTags.some((existing) => existing.id === t.id)
      );
      setSuggestions(filtered);
      setHighlightedIndex(-1);
    } else {
      setSuggestions([]);
      setHighlightedIndex(-1);
    }
  }, [inputValue, state.tags, noteTags]);

  // 添加标签到笔记
  const addTag = useCallback(async (tagName: string) => {
    const trimmed = tagName.trim();
    if (!trimmed || isAdding) return;

    // 防止重复
    if (noteTags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
      setInputValue("");
      return;
    }

    setIsAdding(true);
    try {
      // 查找已存在的全局标签
      let tag = state.tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());

      if (!tag) {
        // 创建新标签
        tag = await api.createTag({ name: trimmed });
        // 刷新全局标签列表
        const allTags = await api.getTags();
        actions.setTags(allTags);
      }

      // 关联到笔记
      await api.addTagToNote(noteId, tag.id);

      const newTags = [...noteTags, tag];
      onTagsChange?.(newTags);
    } catch (err) {
      console.error("Failed to add tag:", err);
    } finally {
      setIsAdding(false);
      setInputValue("");
      setSuggestions([]);
    }
  }, [noteId, noteTags, state.tags, isAdding, actions, onTagsChange]);

  // 移除标签
  const removeTag = useCallback(async (tagId: string) => {
    try {
      await api.removeTagFromNote(noteId, tagId);
      const newTags = noteTags.filter((t) => t.id !== tagId);
      onTagsChange?.(newTags);
      // 刷新全局标签计数
      const allTags = await api.getTags();
      actions.setTags(allTags);
    } catch (err) {
      console.error("Failed to remove tag:", err);
    }
  }, [noteId, noteTags, actions, onTagsChange]);

  // 键盘事件
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
        addTag(suggestions[highlightedIndex].name);
      } else if (inputValue.trim()) {
        addTag(inputValue);
      }
    } else if (e.key === "Backspace" && inputValue === "" && noteTags.length > 0) {
      removeTag(noteTags[noteTags.length - 1].id);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const maxIndex = inputValue.trim() && suggestions.length === 0 ? 0 : suggestions.length - 1;
      setHighlightedIndex((prev) => Math.min(prev + 1, maxIndex));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Escape") {
      setInputValue("");
      setSuggestions([]);
      inputRef.current?.blur();
    }
  };

  const handleBlur = () => {
    blurTimerRef.current = setTimeout(() => setIsFocused(false), 200);
  };

  const handleFocus = () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    setIsFocused(true);
  };

  const showDropdown = isFocused && inputValue.trim().length > 0;
  const hasExactMatch = suggestions.some((s) => s.name.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <div className="relative w-full">
      <div
        className={`flex flex-wrap items-center gap-1.5 px-3 py-1.5 transition-colors ${
          isFocused ? "border-b border-accent-primary/30" : "border-b border-transparent hover:border-app-border"
        }`}
        onClick={() => inputRef.current?.focus()}
      >
        <Hash className="w-3.5 h-3.5 text-tx-tertiary shrink-0" />

        {/* 已有标签列表 */}
        <AnimatePresence mode="popLayout">
          {noteTags.map((tag) => (
            <motion.span
              key={tag.id}
              layout
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md text-[11px] font-medium group/tag cursor-default border transition-colors"
              style={{
                backgroundColor: tag.color + "15",
                borderColor: tag.color + "30",
                color: tag.color,
              }}
            >
              <span>{tag.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeTag(tag.id);
                }}
                className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 opacity-0 group-hover/tag:opacity-100 transition-opacity"
              >
                <X size={10} />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>

        {/* 输入框 */}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          disabled={isAdding}
          className="flex-1 min-w-[80px] bg-transparent text-[11px] text-tx-primary outline-none placeholder:text-tx-tertiary"
          placeholder={noteTags.length === 0 ? "添加标签..." : ""}
        />
      </div>

      {/* 联想下拉菜单 */}
      <AnimatePresence>
        {showDropdown && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute z-50 top-full left-0 mt-1 w-56 max-h-44 overflow-y-auto bg-app-elevated border border-app-border rounded-lg shadow-xl"
          >
            {suggestions.map((tag, i) => (
              <button
                key={tag.id}
                onClick={() => addTag(tag.name)}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                  i === highlightedIndex
                    ? "bg-accent-primary/10 text-accent-primary"
                    : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                <span className="flex-1 truncate">{tag.name}</span>
                {tag.noteCount !== undefined && (
                  <span className="text-[10px] text-tx-tertiary">{tag.noteCount}</span>
                )}
              </button>
            ))}

            {/* 如果没有精确匹配，显示"创建新标签"选项 */}
            {!hasExactMatch && inputValue.trim() && (
              <button
                onClick={() => addTag(inputValue)}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 border-t border-app-border ${
                  suggestions.length === 0 || highlightedIndex === suggestions.length
                    ? "bg-accent-primary/10 text-accent-primary"
                    : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                }`}
              >
                <Plus size={12} className="shrink-0" />
                <span>
                  创建标签 <strong>"{inputValue.trim()}"</strong>
                </span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
