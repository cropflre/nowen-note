import React, { forwardRef, useEffect, useState } from 'react'

/**
 * 轻量 emoji 候选浮层（不依赖 tippy）。
 * 由 TiptapEditor 中 Emoji 扩展的 suggestion.render 通过 ReactRenderer 渲染到这里。
 * props.items / props.command 由 @tiptap/extension-emoji 的默认 suggestion 提供。
 */
interface EmojiItemLike {
  emoji?: string
  name?: string
  [key: string]: unknown
}

interface EmojiListProps {
  items: EmojiItemLike[]
  command: (item: EmojiItemLike) => void
}

export const EmojiSuggestionList = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  EmojiListProps
>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => setSelectedIndex(0), [props.items])

  const selectItem = (index: number) => {
    const item = props.items[index]
    if (item) {
      // emoji 扩展的默认 command 会把整个 EmojiItem 作为节点 attrs 插入
      props.command(item)
    }
  }

  const upHandler = () =>
    setSelectedIndex((i) => (i + props.items.length - 1) % props.items.length)
  const downHandler = () =>
    setSelectedIndex((i) => (i + 1) % props.items.length)
  const enterHandler = () => selectItem(selectedIndex)

  React.useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        upHandler()
        return true
      }
      if (event.key === 'ArrowDown') {
        downHandler()
        return true
      }
      if (event.key === 'Enter') {
        enterHandler()
        return true
      }
      return false
    },
  }))

  if (props.items.length === 0) {
    return <div className="emoji-suggestion emoji-suggestion--empty">无匹配表情</div>
  }

  return (
    <div className="emoji-suggestion">
      {props.items.map((item, index) => (
        <button
          key={item.name ?? index}
          type="button"
          className={
            'emoji-suggestion__item' +
            (index === selectedIndex ? ' is-selected' : '')
          }
          onMouseEnter={() => setSelectedIndex(index)}
          onMouseDown={(e) => {
            e.preventDefault()
            selectItem(index)
          }}
        >
          <span className="emoji-suggestion__emoji">{item.emoji}</span>
          <span className="emoji-suggestion__name">{item.name}</span>
        </button>
      ))}
    </div>
  )
})

EmojiSuggestionList.displayName = 'EmojiSuggestionList'
