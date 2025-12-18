import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChatProvider } from './contexts/ChatContext'
import { Chat } from './components/Chat'
import { useDarkMode } from '@common/hooks/useDarkMode'

const SidebarContent: React.FC = () => {
    const { isDarkMode } = useDarkMode()

    const [isResizing, setIsResizing] = useState(false)
    const startWidthRef = useRef<number>(0)
    const currentWidthRef = useRef<number>(0)
    const handleRef = useRef<HTMLDivElement | null>(null)

    const beginResize = useCallback((e: React.MouseEvent) => {
        setIsResizing(true)
        const stored = localStorage.getItem('sidebarWidth')
        const parsed = stored ? Number(stored) : NaN
        startWidthRef.current = Number.isFinite(parsed) ? parsed : 400
        currentWidthRef.current = startWidthRef.current
        handleRef.current?.requestPointerLock()
        e.preventDefault()
        e.stopPropagation()
    }, [])

    const applyWidth = useCallback(async (width: number) => {
        try {
            const next = await window.sidebarAPI.setSidebarWidth(width)
            localStorage.setItem('sidebarWidth', String(next))
        } catch {
            // ignore
        }
    }, [])

    // Apply dark mode class to the document
    useEffect(() => {
        if (isDarkMode) {
            document.documentElement.classList.add('dark')
        } else {
            document.documentElement.classList.remove('dark')
        }
    }, [isDarkMode])

    useEffect(() => {
        const stored = localStorage.getItem('sidebarWidth')
        const parsed = stored ? Number(stored) : NaN

        if (Number.isFinite(parsed)) {
            applyWidth(parsed)
            return
        }

        window.sidebarAPI
            .getSidebarWidth()
            .then((w) => localStorage.setItem('sidebarWidth', String(w)))
            .catch(() => {
                // ignore
            })
    }, [applyWidth])

    useEffect(() => {
        if (!isResizing) return

        const onMove = (e: MouseEvent) => {
            if (document.pointerLockElement !== handleRef.current) return
            const next = currentWidthRef.current - e.movementX
            currentWidthRef.current = next
            applyWidth(next)
        }

        const onUp = () => {
            setIsResizing(false)
            if (document.pointerLockElement) {
                document.exitPointerLock()
            }
        }

        const onPointerLockChange = () => {
            if (!document.pointerLockElement) {
                setIsResizing(false)
            }
        }

        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        document.addEventListener('pointerlockchange', onPointerLockChange)
        return () => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.removeEventListener('pointerlockchange', onPointerLockChange)
        }
    }, [applyWidth, isResizing])

    return (
        <div className="h-screen flex flex-col bg-background border-l border-border relative">
            <div
                ref={handleRef}
                className="absolute left-0 inset-y-0 w-2 cursor-ew-resize z-50 pointer-events-auto bg-transparent hover:bg-muted/30"
                onMouseDown={beginResize}
            />

            <div
                className="absolute left-0 top-1/2 -translate-y-1/2 h-16 w-3 cursor-ew-resize flex items-center justify-center z-50"
                onMouseDown={beginResize}
            >
                <div className="h-10 w-[2px] rounded-full bg-muted-foreground/20" />
            </div>
            <Chat />
        </div>
    )
}

export const SidebarApp: React.FC = () => {
    return (
        <ChatProvider>
            <SidebarContent />
        </ChatProvider>
    )
}

