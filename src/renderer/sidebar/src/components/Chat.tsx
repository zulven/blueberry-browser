import React, { useState, useRef, useEffect, useLayoutEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { ArrowUp, ChevronDown, ChevronUp, Plus } from 'lucide-react'
import { useChat } from '../contexts/ChatContext'
import { cn } from '@common/lib/utils'
import { Button } from '@common/components/Button'

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    isStreaming?: boolean
}

// Auto-scroll hook
const useAutoScroll = (params: {
    scrollContainerRef: React.RefObject<HTMLDivElement | null>
    deps: any[]
}) => {
    const { scrollContainerRef, deps } = params
    const scrollRef = useRef<HTMLDivElement>(null)
    const shouldAutoScrollRef = useRef(true)

    useEffect(() => {
        const el = scrollContainerRef.current
        if (!el) return

        const nearBottomThresholdPx = 140
        const update = () => {
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
            shouldAutoScrollRef.current = distanceFromBottom <= nearBottomThresholdPx
        }

        update()
        el.addEventListener('scroll', update, { passive: true })
        return () => el.removeEventListener('scroll', update)
    }, [scrollContainerRef])

    useLayoutEffect(() => {
        if (!shouldAutoScrollRef.current) return
        // allow layout to settle (markdown, syntax highlight, etc)
        window.setTimeout(() => {
            if (!shouldAutoScrollRef.current) return
            scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
        }, 50)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)

    return scrollRef
}

// User Message Component - appears on the right
const UserMessage: React.FC<{ content: string }> = ({ content }) => (
    <div className="relative max-w-[85%] ml-auto animate-fade-in">
        <div className="bg-muted dark:bg-muted/50 rounded-3xl px-6 py-4">
            <div className="text-foreground" style={{ whiteSpace: 'pre-wrap' }}>
                {content}
            </div>
        </div>
    </div>
)

// Streaming Text Component
const StreamingText: React.FC<{ content: string }> = ({ content }) => {
    const [displayedContent, setDisplayedContent] = useState('')
    const [currentIndex, setCurrentIndex] = useState(0)

    useEffect(() => {
        if (currentIndex >= content.length) return undefined

        const timer = setTimeout(() => {
            setDisplayedContent(content.slice(0, currentIndex + 1))
            setCurrentIndex(currentIndex + 1)
        }, 10)

        return () => clearTimeout(timer)
    }, [content, currentIndex])

    return (
        <div className="whitespace-pre-wrap text-foreground">
            {displayedContent}
            {currentIndex < content.length && (
                <span className="inline-block w-2 h-5 bg-primary/60 dark:bg-primary/40 ml-0.5 animate-pulse" />
            )}
        </div>
    )
}

// Markdown Renderer Component
const Markdown: React.FC<{ content: string; className?: string }> = ({ content, className }) => (
    <div className={cn(
        `prose prose-sm dark:prose-invert max-w-none
        prose-headings:text-foreground prose-p:text-foreground
        prose-strong:text-foreground prose-ul:text-foreground
        prose-ol:text-foreground prose-li:text-foreground
        prose-a:text-primary hover:prose-a:underline
        prose-code:bg-muted prose-code:px-1 prose-code:py-0.5
        prose-code:rounded prose-code:text-sm prose-code:text-foreground
        prose-pre:bg-muted dark:prose-pre:bg-muted/50 prose-pre:p-3
        prose-pre:rounded-lg prose-pre:overflow-x-auto`,
        className
    )}>
        <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[rehypeHighlight]}
            components={{
                h1: ({ children }) => (
                    <h1 className="mt-6 mb-3 text-2xl font-semibold tracking-tight text-foreground">
                        {children}
                    </h1>
                ),
                h2: ({ children }) => (
                    <h2 className="mt-5 mb-3 text-xl font-semibold tracking-tight text-foreground">
                        {children}
                    </h2>
                ),
                h3: ({ children }) => (
                    <h3 className="mt-4 mb-2 text-lg font-semibold tracking-tight text-foreground">
                        {children}
                    </h3>
                ),
                h4: ({ children }) => (
                    <h4 className="mt-4 mb-2 text-base font-semibold tracking-tight text-foreground">
                        {children}
                    </h4>
                ),
                table: ({ children }) => (
                    <div className="my-4 w-full overflow-x-auto rounded-lg border border-border">
                        <table className="w-full border-collapse text-sm">{children}</table>
                    </div>
                ),
                thead: ({ children }) => (
                    <thead className="bg-muted/40 dark:bg-muted/20">{children}</thead>
                ),
                th: ({ children }) => (
                    <th className="border-b border-border px-3 py-2 text-left font-medium text-foreground">
                        {children}
                    </th>
                ),
                td: ({ children }) => (
                    <td className="border-b border-border px-3 py-2 align-top text-foreground">
                        {children}
                    </td>
                ),
                pre: ({ children }) => (
                    <pre className="my-4 overflow-x-auto rounded-lg bg-muted/60 dark:bg-muted/30 p-3">
                        {children}
                    </pre>
                ),
                // Custom code block styling
                code: ({ node, className, children, ...props }) => {
                    const inline = !className
                    return inline ? (
                        <code
                            className="bg-muted dark:bg-muted/50 px-1 py-0.5 rounded text-sm text-foreground"
                            {...props}
                        >
                            {children}
                        </code>
                    ) : (
                        <code className={cn("font-mono text-sm", className)} {...props}>
                            {children}
                        </code>
                    )
                },
                // Custom link styling
                a: ({ children, href }) => (
                    <a
                        href={href}
                        className="text-primary hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {children}
                    </a>
                ),
            }}
        >
            {content}
        </ReactMarkdown>
    </div>
)

// Assistant Message Component - appears on the left
const AssistantMessage: React.FC<{ content: string; isStreaming?: boolean }> = ({
    content,
    isStreaming
}) => (
    <div className="relative w-full animate-fade-in pl-4">
        <div className="py-1">
            {isStreaming ? (
                <StreamingText content={content} />
            ) : (
                <Markdown content={content} />
            )}
        </div>
    </div>
)

// Loading Indicator with spinning blueberry
const LoadingIndicator: React.FC = () => {
    const [isVisible, setIsVisible] = useState(false)

    useEffect(() => {
        setIsVisible(true)
    }, [])

    return (
        <div className={cn(
            "transition-transform duration-300 ease-in-out",
            isVisible ? "scale-100" : "scale-0"
        )}>
            <span className="inline-flex items-center justify-center" aria-label="Loading">
                <span className="inline-block select-none bb-pulse-scale text-lg leading-none">🫐</span>
            </span>
        </div>
    )
}

// Chat Input Component with pill design
const ChatInput: React.FC<{
    onSend: (message: string) => void
    onAbort: () => void
    disabled: boolean
    onAfterSend?: () => void
}> = ({ onSend, onAbort, disabled, onAfterSend }) => {
    const [value, setValue] = useState('')
    const [isFocused, setIsFocused] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
            const scrollHeight = textareaRef.current.scrollHeight
            const newHeight = Math.min(scrollHeight, 200) // Max 200px
            textareaRef.current.style.height = `${newHeight}px`
        }
    }, [value])

    const handleSubmit = () => {
        if (value.trim() && !disabled) {
            onSend(value.trim())
            onAfterSend?.()
            setValue('')
            // Reset textarea height
            if (textareaRef.current) {
                textareaRef.current.style.height = '24px'
            }
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (disabled) {
                onAbort()
            } else {
                handleSubmit()
            }
        }
    }

    return (
        <div className={cn(
            "w-full border p-3 rounded-3xl bg-background dark:bg-secondary",
            "shadow-chat animate-spring-scale outline-none transition-all duration-200",
            isFocused ? "border-primary/20 dark:border-primary/30" : "border-border"
        )}>
            {/* Input Area */}
            <div className="w-full px-3 py-2">
                <div className="w-full flex items-start gap-3">
                    <div className="relative flex-1 overflow-hidden">
                        <textarea
                            ref={textareaRef}
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            onFocus={() => setIsFocused(true)}
                            onBlur={() => setIsFocused(false)}
                            onKeyDown={handleKeyDown}
                            placeholder="Send a message..."
                            className="w-full resize-none outline-none bg-transparent 
                                     text-foreground placeholder:text-muted-foreground
                                     min-h-[24px] max-h-[200px]"
                            rows={1}
                            style={{ lineHeight: '24px' }}
                        />
                    </div>
                </div>
            </div>

            {/* Send Button */}
            <div className="w-full flex items-center gap-1.5 px-1 mt-2 mb-1">
                <div className="flex-1" />
                {disabled ? (
                    <button
                        onClick={onAbort}
                        className={cn(
                            "size-9 rounded-full flex items-center justify-center",
                            "transition-all duration-200",
                            "bg-red-500 text-white",
                            "hover:bg-red-600"
                        )}
                        aria-label="Stop"
                        title="Stop"
                    >
                        <span className="inline-block size-3.5 rounded-[2px] bg-white" />
                    </button>
                ) : (
                    <button
                        onClick={handleSubmit}
                        disabled={!value.trim()}
                        className={cn(
                            "size-9 rounded-full flex items-center justify-center",
                            "transition-all duration-200",
                            "bg-primary text-primary-foreground",
                            "hover:opacity-80 disabled:opacity-50"
                        )}
                    >
                        <ArrowUp className="size-5" />
                    </button>
                )}
            </div>
        </div>
    )
}

// Conversation Turn Component
interface ConversationTurn {
    user?: Message
    assistant?: Message
}

const ConversationTurnComponent: React.FC<{
    turn: ConversationTurn
    isLoading?: boolean
    reasoning?: string
    isReasoningComplete?: boolean
    navigation?: string
    isNavigationComplete?: boolean
    navigationStepCurrent?: number | null
    navigationStepTotal?: number | null
    navigationStepsCompleted?: number
}> = ({ turn, isLoading, reasoning, isReasoningComplete, navigation, isNavigationComplete, navigationStepCurrent, navigationStepTotal, navigationStepsCompleted }) => {

    const [isReasoningCollapsed, setIsReasoningCollapsed] = useState(false)
    const [isNavigationCollapsed, setIsNavigationCollapsed] = useState(false)

    const [thinkingStartedAt, setThinkingStartedAt] = useState<number | null>(null)
    const [thinkingElapsedMs, setThinkingElapsedMs] = useState<number>(0)

    useEffect(() => {
        if (!reasoning || reasoning.length === 0) return

        if (isReasoningComplete) {
            setIsReasoningCollapsed(true)
        } else {
            setIsReasoningCollapsed(false)
        }
    }, [reasoning, isReasoningComplete])

    useEffect(() => {
        if (!navigation || navigation.length === 0) return

        if (isNavigationComplete) {
            setIsNavigationCollapsed(true)
        } else {
            setIsNavigationCollapsed(false)
        }
    }, [navigation, isNavigationComplete])

    useEffect(() => {
        if (!reasoning || reasoning.length === 0) return

        if (!isReasoningComplete) {
            setThinkingStartedAt((prev) => prev ?? Date.now())
            return
        }

        setThinkingElapsedMs((prev) => {
            const startedAt = thinkingStartedAt
            if (!startedAt) return prev
            return Date.now() - startedAt
        })
    }, [reasoning, isReasoningComplete, thinkingStartedAt])

    useEffect(() => {
        if (!reasoning || reasoning.length === 0) return
        if (isReasoningComplete) return
        if (!thinkingStartedAt) return

        const id = window.setInterval(() => {
            setThinkingElapsedMs(Date.now() - thinkingStartedAt)
        }, 100)

        return () => window.clearInterval(id)
    }, [reasoning, isReasoningComplete, thinkingStartedAt])

    return (
        <div className="pt-12 flex flex-col gap-8">
            {turn.user && <UserMessage content={turn.user.content} />}
            {turn.user && reasoning && reasoning.length > 0 && (
                <div className="pt-4">
                    <div className="rounded-2xl border border-border bg-muted/40 dark:bg-muted/20 p-4">
                        <div className="flex items-center justify-between gap-3 mb-2">
                            <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                <span
                                    className={cn(
                                        "inline-block size-2.5 rounded-full",
                                        "shadow-[0_0_0_2px_rgba(255,255,255,0.04)]",
                                        !isReasoningComplete
                                            ? "animate-pulse border border-teal-400/75 bg-transparent"
                                            : "bg-teal-400/75"
                                    )}
                                />

                                {!isReasoningComplete
                                    ? 'Thinking'
                                    : `Thought for ${Math.max(0, thinkingElapsedMs / 1000).toFixed(1)}s`}
                            </div>

                            <button
                                type="button"
                                onClick={() => setIsReasoningCollapsed((v) => !v)}
                                className={cn(
                                    "inline-flex items-center justify-center",
                                    "size-7 rounded-md",
                                    "text-muted-foreground hover:text-foreground",
                                    "hover:bg-muted/70 dark:hover:bg-muted/30"
                                )}
                                aria-label={isReasoningCollapsed ? 'Expand reasoning' : 'Collapse reasoning'}
                                title={isReasoningCollapsed ? 'Expand reasoning' : 'Collapse reasoning'}
                            >
                                {isReasoningCollapsed ? (
                                    <ChevronDown className="size-4" />
                                ) : (
                                    <ChevronUp className="size-4" />
                                )}
                            </button>
                        </div>

                        <div
                            className={cn(
                                "origin-top transition-all duration-200",
                                isReasoningCollapsed
                                    ? "scale-y-0 opacity-0 max-h-0 pointer-events-none"
                                    : "scale-y-100 opacity-100 max-h-[1000px]"
                            )}
                        >
                            <Markdown
                                content={reasoning}
                                className="opacity-55 prose-p:text-muted-foreground/45 prose-li:text-muted-foreground/45 prose-headings:text-muted-foreground/45 prose-strong:text-foreground/60 prose-code:text-muted-foreground/50"
                            />
                        </div>
                    </div>
                </div>
            )}

            {turn.user && navigation && navigation.length > 0 && (
                <div className="pt-4">
                    <div className="rounded-2xl border border-border bg-muted/40 dark:bg-muted/20 p-4">
                        <div className="flex items-center justify-between gap-3 mb-2">
                            <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                <span
                                    className={cn(
                                        "inline-block size-2.5 rounded-full",
                                        "shadow-[0_0_0_2px_rgba(255,255,255,0.04)]",
                                        !isNavigationComplete
                                            ? "animate-pulse border border-indigo-400/75 bg-transparent"
                                            : "bg-indigo-400/75"
                                    )}
                                />

                                <span>{!isNavigationComplete ? 'Navigating...' : 'Navigation log'}</span>

                                {!isNavigationComplete ? (
                                    typeof navigationStepCurrent === 'number' &&
                                    typeof navigationStepTotal === 'number' &&
                                    Number.isFinite(navigationStepCurrent) &&
                                    Number.isFinite(navigationStepTotal) ? (
                                        <span>{`Step ${navigationStepCurrent}/${navigationStepTotal}`}</span>
                                    ) : null
                                ) : (
                                    (typeof navigationStepsCompleted === 'number' ? navigationStepsCompleted : 0) > 0
                                        ? <span>{`(${typeof navigationStepsCompleted === 'number' ? navigationStepsCompleted : 0} steps)`}</span>
                                        : null
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => setIsNavigationCollapsed((v) => !v)}
                                className={cn(
                                    "inline-flex items-center justify-center",
                                    "size-7 rounded-md",
                                    "text-muted-foreground hover:text-foreground",
                                    "hover:bg-muted/70 dark:hover:bg-muted/30"
                                )}
                                aria-label={isNavigationCollapsed ? 'Expand navigation' : 'Collapse navigation'}
                                title={isNavigationCollapsed ? 'Expand navigation' : 'Collapse navigation'}
                            >
                                {isNavigationCollapsed ? (
                                    <ChevronDown className="size-4" />
                                ) : (
                                    <ChevronUp className="size-4" />
                                )}
                            </button>
                        </div>

                        <div
                            className={cn(
                                "origin-top transition-all duration-200",
                                isNavigationCollapsed
                                    ? "scale-y-0 opacity-0 max-h-0 pointer-events-none"
                                    : "scale-y-100 opacity-100 max-h-[1000px]"
                            )}
                        >
                            <div className="text-sm font-medium text-muted-foreground whitespace-pre-wrap">
                                {(() => {
                                    const lines = navigation
                                        .split(/\r?\n+/)
                                        .map((l) => l.trim())
                                        .filter((l) => l.length > 0)

                                    let n = 0
                                    return lines.map((line, idx) => {
                                        if (line === 'Navigation complete') {
                                            return <div key={`nav-line-${idx}`}>{line}</div>
                                        }

                                        n += 1
                                        return <div key={`nav-line-${idx}`}>{n}. {line}</div>
                                    })
                                })()}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {turn.assistant && (
                <AssistantMessage
                    content={turn.assistant.content}
                    isStreaming={turn.assistant.isStreaming}
                />
            )}

            {isLoading && (
                <div className="flex justify-start">
                    <LoadingIndicator />
                </div>
            )}
        </div>
    )
}

// Main Chat Component
export const Chat: React.FC = () => {
    const { messages, isLoading, sendMessage, abortChat, clearChat, reasoning, isReasoningComplete, navigation, isNavigationComplete, navigationStepCurrent, navigationStepTotal, navigationStepsCompleted } = useChat()

    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const scrollRef = useAutoScroll({
        scrollContainerRef,
        deps: [messages.length, reasoning.length, navigation.length]
    })

    const scrollToBottomNow = () => {
        window.setTimeout(() => {
            scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
        }, 0)
    }

    // Group messages into conversation turns
    const conversationTurns: ConversationTurn[] = []
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user') {
            const turn: ConversationTurn = { user: messages[i] }
            if (messages[i + 1]?.role === 'assistant') {
                turn.assistant = messages[i + 1]
                i++ // Skip next message since we've paired it
            }
            conversationTurns.push(turn)
        } else if (messages[i].role === 'assistant' &&
            (i === 0 || messages[i - 1]?.role !== 'user')) {
            // Handle standalone assistant messages
            conversationTurns.push({ assistant: messages[i] })
        }
    }

    // Check if we need to show loading after the last turn
    const showLoadingAfterLastTurn = isLoading &&
        messages[messages.length - 1]?.role === 'user'

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Messages Area */}
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">

                <div className="h-8 max-w-3xl mx-auto px-4">
                    {/* New Chat Button - Floating */}
                    {messages.length > 0 && (
                        <Button
                            onClick={clearChat}
                            title="Start new chat"
                            variant="ghost"
                        >
                            <Plus className="size-4" />
                            New Chat
                        </Button>
                    )}
                </div>

                <div className="pb-4 relative max-w-3xl mx-auto px-4">
                    {messages.length === 0 ? (
                        // Empty State
                        <div className="flex items-center justify-center h-full min-h-[400px]">

                            <div className="text-center animate-fade-in max-w-md mx-auto gap-2 flex flex-col">
                                <h3 className="text-2xl font-bold">🫐</h3>
                                <p className="text-muted-foreground text-sm">
                                    Press ⌘E to toggle the sidebar
                                </p>
                            </div>
                        </div>
                    ) : (
                        <>

                            {/* Render conversation turns */}
                            {conversationTurns.map((turn, index) => (
                                (() => {
                                    const isLastTurn = index === conversationTurns.length - 1
                                    const showReasoningInline =
                                        isLastTurn &&
                                        !!turn.user &&
                                        reasoning.length > 0

                                    const showNavigationInline =
                                        isLastTurn &&
                                        !!turn.user &&
                                        navigation.length > 0

                                    return (
                                        <ConversationTurnComponent
                                            key={`turn-${index}`}
                                            turn={turn}
                                            reasoning={showReasoningInline ? reasoning : undefined}
                                            isReasoningComplete={isReasoningComplete}
                                            navigation={showNavigationInline ? navigation : undefined}
                                            isNavigationComplete={isNavigationComplete}
                                            navigationStepCurrent={navigationStepCurrent}
                                            navigationStepTotal={navigationStepTotal}
                                            navigationStepsCompleted={navigationStepsCompleted}
                                            isLoading={
                                                showLoadingAfterLastTurn &&
                                                index === conversationTurns.length - 1
                                            }
                                        />
                                    )
                                })()
                            ))}
                        </>
                    )}

                    {/* Scroll anchor */}
                    <div ref={scrollRef} />
                </div>
            </div>

            {/* Input Area */}
            <div className="p-4">
                <ChatInput
                    onSend={sendMessage}
                    onAbort={abortChat}
                    disabled={isLoading}
                    onAfterSend={scrollToBottomNow}
                />
            </div>
        </div>
    )
}