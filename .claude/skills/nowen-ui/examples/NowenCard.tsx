import React, { useEffect, useRef } from 'react'

type NowenCardProps = React.HTMLAttributes<HTMLDivElement> & {
  spotlightColor?: string
  lightweight?: boolean
}

export function NowenCard({
  children,
  className = '',
  spotlightColor = 'rgba(102, 126, 234, 0.15)',
  lightweight = false,
  ...props
}: NowenCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (lightweight) return
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const element = ref.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      element.style.setProperty('--spotlight-x', `${event.clientX - rect.left}px`)
      element.style.setProperty('--spotlight-y', `${event.clientY - rect.top}px`)
    })
  }

  return (
    <div
      ref={ref}
      onPointerMove={handlePointerMove}
      className={`nowen-glass nowen-card group ${className}`}
      style={{ '--spotlight-color': spotlightColor } as React.CSSProperties}
      {...props}
    >
      {!lightweight && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px hidden rounded-2xl opacity-0 transition-opacity duration-300 dark:block group-hover:opacity-100"
          style={{
            background:
              'radial-gradient(600px circle at var(--spotlight-x, 50%) var(--spotlight-y, 50%), var(--spotlight-color), transparent 40%)',
          }}
        />
      )}
      <div className="relative z-10">{children}</div>
    </div>
  )
}
