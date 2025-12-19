import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'

interface Message {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    isStreaming?: boolean
}

interface ChatContextType {
    messages: Message[]
    isLoading: boolean

    reasoning: string
    isReasoningComplete: boolean

    navigation: string
    isNavigationComplete: boolean

    navigationStepCurrent: number | null
    navigationStepTotal: number | null
    navigationStepsCompleted: number

    // Chat actions
    sendMessage: (content: string) => Promise<void>
    abortChat: () => Promise<void>
    clearChat: () => void

    // Page content access
    getPageContent: () => Promise<string | null>
    getPageText: () => Promise<string | null>
    getCurrentUrl: () => Promise<string | null>
}

const ChatContext = createContext<ChatContextType | null>(null)

export const useChat = () => {
    const context = useContext(ChatContext)
    if (!context) {
        throw new Error('useChat must be used within a ChatProvider')
    }
    return context
}

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [messages, setMessages] = useState<Message[]>([])
    const [isLoading, setIsLoading] = useState(false)

    const [reasoning, setReasoning] = useState('')
    const [isReasoningComplete, setIsReasoningComplete] = useState(true)

    const [navigation, setNavigation] = useState('')
    const [isNavigationComplete, setIsNavigationComplete] = useState(true)

    const [navigationStepCurrent, setNavigationStepCurrent] = useState<number | null>(null)
    const [navigationStepTotal, setNavigationStepTotal] = useState<number | null>(null)
    const [navigationStepsCompleted, setNavigationStepsCompleted] = useState(0)

    const navigationLineBufferRef = useRef('')

    // Load initial messages from main process
    useEffect(() => {
        const loadMessages = async () => {
            try {
                const storedMessages = await window.sidebarAPI.getMessages()
                if (storedMessages && storedMessages.length > 0) {
                    // Convert CoreMessage format to our frontend Message format
                    const convertedMessages = storedMessages.map((msg: any, index: number) => ({
                        id: `msg-${index}`,
                        role: msg.role,
                        content: typeof msg.content === 'string' 
                            ? msg.content 
                            : msg.content.find((p: any) => p.type === 'text')?.text || '',
                        timestamp: Date.now(),
                        isStreaming: false
                    }))
                    setMessages(convertedMessages)
                }
            } catch (error) {
                console.error('Failed to load messages:', error)
            }
        }
        loadMessages()
    }, [])

    const abortChat = useCallback(async () => {
        try {
            await window.sidebarAPI.abortChat()
        } catch (error) {
            console.error('Failed to abort chat:', error)
        } finally {
            setIsLoading(false)
            setIsReasoningComplete(true)
            setIsNavigationComplete(true)
        }
    }, [])

    const sendMessage = useCallback(async (content: string) => {
        setIsLoading(true)
        setReasoning('')
        setIsReasoningComplete(false)

        setNavigation('')
        setIsNavigationComplete(false)

        setNavigationStepCurrent(null)
        setNavigationStepTotal(null)
        setNavigationStepsCompleted(0)
        navigationLineBufferRef.current = ''

        try {
            const messageId = Date.now().toString()

            // Send message to main process (which will handle context)
            await window.sidebarAPI.sendChatMessage({
                message: content,
                messageId: messageId
            })

            // Messages will be updated via the chat-messages-updated event
        } catch (error) {
            console.error('Failed to send message:', error)
            setIsLoading(false)
        }
    }, [])

    const clearChat = useCallback(async () => {
        try {
            await window.sidebarAPI.clearChat()
            setMessages([])
            setReasoning('')
            setIsReasoningComplete(true)
            setNavigation('')
            setIsNavigationComplete(true)

            setNavigationStepCurrent(null)
            setNavigationStepTotal(null)
            setNavigationStepsCompleted(0)
            navigationLineBufferRef.current = ''
        } catch (error) {
            console.error('Failed to clear chat:', error)
        }
    }, [])

    const getPageContent = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageContent()
        } catch (error) {
            console.error('Failed to get page content:', error)
            return null
        }
    }, [])

    const getPageText = useCallback(async () => {
        try {
            return await window.sidebarAPI.getPageText()
        } catch (error) {
            console.error('Failed to get page text:', error)
            return null
        }
    }, [])

    const getCurrentUrl = useCallback(async () => {
        try {
            return await window.sidebarAPI.getCurrentUrl()
        } catch (error) {
            console.error('Failed to get current URL:', error)
            return null
        }
    }, [])

    // Set up message listeners
    useEffect(() => {
        // In dev (hot reload / React strict effects), this file can be re-evaluated and
        // listeners can accumulate. Clear any existing listeners before registering.
        window.sidebarAPI.removeChatResponseListener()
        window.sidebarAPI.removeChatReasoningListener()
        window.sidebarAPI.removeChatNavigationListener()
        window.sidebarAPI.removeMessagesUpdatedListener()

        // Listen for streaming response updates
        const handleChatResponse = (data: { messageId: string; content: string; isComplete: boolean }) => {
            if (data.isComplete) {
                setIsLoading(false)
            }
        }

        const handleChatReasoning = (data: { messageId: string; content: string; isComplete: boolean }) => {
            if (data.content) {
                setReasoning((prev) => prev + data.content)
            }
            if (data.isComplete) {
                setIsReasoningComplete(true)
            }
        }

        const handleChatNavigation = (data: { messageId: string; content: string; isComplete: boolean }) => {
            if (data.content) {
                navigationLineBufferRef.current += data.content
                const parts = navigationLineBufferRef.current.split(/\r?\n/)
                const completeLines = parts.slice(0, -1)
                navigationLineBufferRef.current = parts[parts.length - 1] ?? ''

                const prettyLines: string[] = []

                for (const rawLine of completeLines) {
                    const line = rawLine.trim()
                    if (!line) continue

                    const cleaned = line.replace(/^Computer Use\s*:\s*/i, '').trim()

                    const stepMatch = cleaned.match(/\bstep\s+(\d+)\s*\/\s*(\d+)\b/i)
                    if (stepMatch) {
                        const cur = Number(stepMatch[1])
                        const total = Number(stepMatch[2])
                        if (Number.isFinite(cur)) setNavigationStepCurrent(cur)
                        if (Number.isFinite(total)) setNavigationStepTotal(total)
                        continue
                    }

                    if (/\bdone\b/i.test(cleaned) && /no more actions/i.test(cleaned)) {
                        continue
                    }

                    const jsonStart = cleaned.indexOf('{')
                    const actionPart = (jsonStart >= 0 ? cleaned.slice(0, jsonStart) : cleaned).trim()
                    const jsonPart = jsonStart >= 0 ? cleaned.slice(jsonStart).trim() : ''

                    let parsedArgs: any = null
                    if (jsonPart) {
                        try {
                            parsedArgs = JSON.parse(jsonPart)
                        } catch {
                            parsedArgs = null
                        }
                    }

                    const lowerAction = actionPart.toLowerCase()

                    let pretty = ''
                    if (lowerAction.includes('type_text')) {
                        const text = parsedArgs && typeof parsedArgs.text === 'string' ? parsedArgs.text : ''
                        const enter = parsedArgs && typeof parsedArgs.enter === 'boolean' ? parsedArgs.enter : false
                        const safeText = text.length > 0 ? ` “${text}”` : ''
                        pretty = enter ? `Submitting${safeText}` : `Typing${safeText}`
                    } else if (lowerAction.includes('search')) {
                        pretty = 'Searching'
                    } else if (lowerAction.includes('click')) {
                        pretty = 'Clicking element'
                    } else if (lowerAction.includes('scroll')) {
                        pretty = 'Scrolling'
                    } else if (
                        lowerAction.includes('navigate') ||
                        lowerAction.includes('open_url') ||
                        lowerAction.includes('openurl')
                    ) {
                        pretty = 'Opening page'
                    } else if (lowerAction.includes('wait')) {
                        pretty = 'Waiting'
                    } else if (lowerAction.includes('key') || lowerAction.includes('keypress')) {
                        pretty = 'Pressing keys'
                    } else {
                        pretty = 'Continuing'
                    }

                    prettyLines.push(pretty)
                }

                if (prettyLines.length > 0) {
                    setNavigation((prevNav) => {
                        const prefix = prevNav ? '\n' : ''
                        return prevNav + prefix + prettyLines.join('\n')
                    })
                    setNavigationStepsCompleted((prevCount) => prevCount + prettyLines.length)
                }
            }

            if (data.isComplete) {
                setIsNavigationComplete(true)
                setNavigation((prev) => {
                    if (!prev || prev.trim().length === 0) return prev
                    if (prev.trim().endsWith('Navigation complete')) return prev
                    return prev + (prev ? '\n\n' : '') + 'Navigation complete'
                })
            }
        }

        // Listen for message updates from main process
        const handleMessagesUpdated = (updatedMessages: any[]) => {
            // Convert CoreMessage format to our frontend Message format
            const convertedMessages = updatedMessages.map((msg: any, index: number) => ({
                id: `msg-${index}`,
                role: msg.role,
                content: typeof msg.content === 'string' 
                    ? msg.content 
                    : msg.content.find((p: any) => p.type === 'text')?.text || '',
                timestamp: Date.now(),
                isStreaming: false
            }))
            setMessages(convertedMessages)
        }

        window.sidebarAPI.onChatResponse(handleChatResponse)
        window.sidebarAPI.onChatReasoning(handleChatReasoning)
        window.sidebarAPI.onChatNavigation(handleChatNavigation)
        window.sidebarAPI.onMessagesUpdated(handleMessagesUpdated)

        return () => {
            window.sidebarAPI.removeChatResponseListener()
            window.sidebarAPI.removeChatReasoningListener()
            window.sidebarAPI.removeChatNavigationListener()
            window.sidebarAPI.removeMessagesUpdatedListener()
        }
    }, [])

    const value: ChatContextType = {
        messages,
        isLoading,

        reasoning,
        isReasoningComplete,

        navigation,
        isNavigationComplete,

        navigationStepCurrent,
        navigationStepTotal,
        navigationStepsCompleted,

        sendMessage,
        abortChat,
        clearChat,
        getPageContent,
        getPageText,
        getCurrentUrl
    }

    return (
        <ChatContext.Provider value={value}>
            {children}
        </ChatContext.Provider>
    )
}

