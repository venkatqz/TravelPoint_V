import React, { useEffect, useState, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import { SocketService } from '../../services/SocketService';
import { 
    Box, TextField, IconButton, Typography, Paper, 
    Avatar, Chip
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import SupportAgentIcon from '@mui/icons-material/SupportAgent';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import dayjs from 'dayjs';

// 1. IMPORT THE CSS FILE
import './ChatWindow.css'; 

interface Message {
    _id?: string;
    sender_role: string;
    message: string;
    created_at?: string;
}

interface ChatWindowProps {
    mode?: 'socket' | 'ai';
    bookingId?: number;
    userRole?: 'passenger' | 'operator'; 
    onClose?: ()=> void;
}

export const ChatWindow = ({ 
    mode = 'socket', 
    bookingId, 
    userRole = 'passenger' 
}: ChatWindowProps) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [currentMessage, setCurrentMessage] = useState("");
    const [connected, setConnected] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    
    const socketRef = useRef<Socket | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const isMe = (msgRole: string) => {
        if (mode === 'ai') return msgRole !== 'bot';
        return msgRole?.toLowerCase() === userRole.toLowerCase();
    };

    useEffect(() => {
        if (mode === 'ai') {
            setConnected(true);
            setMessages([{ 
                sender_role: 'bot', 
                message: "Hello! I am your AI Assistant. How can I help you today?", 
                created_at: new Date().toISOString() 
            }]);
            return;
        }

        if (!bookingId) return;

        socketRef.current = SocketService.getSocket();
        const socket = socketRef.current;

        if (!socket) return;

        const handleConnect = () => {
            setConnected(true);
            socket.emit('join_room', bookingId); 
            socket.emit('mark_messages_as_read', bookingId);
        };

        const handleHistory = (history: Message[]) => {
            setMessages(history);
            scrollToBottom();
        };

        const handleReceive = (message: Message) => {
            setMessages((prev) => [...prev, message]);
            scrollToBottom();
        };

        socket.on('connect', handleConnect);
        socket.on('load_chat_history', handleHistory);
        socket.on('receive_message', handleReceive);

        if (socket.connected) handleConnect();

        return () => { 
            socket.off('connect', handleConnect);
            socket.off('load_chat_history', handleHistory);
            socket.off('receive_message', handleReceive);
        };
    }, [bookingId, mode]);

    const scrollToBottom = () => {
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 100);
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isTyping]);

    const sendMessage = async () => {
        if (!currentMessage.trim()) return;
        const text = currentMessage;
        setCurrentMessage("");

        const userMsg: Message = { 
            sender_role: userRole, 
            message: text, 
            created_at: new Date().toISOString() 
        };

        if (mode === 'ai') {
            setMessages(prev => [...prev, userMsg]);
            setIsTyping(true);

            try {
                const userDataString = localStorage.getItem('user_data');
                
                if (!userDataString) {
                    setMessages(prev => [...prev, {
                        sender_role: 'bot',
                        message: "⚠️ Please log in to use the AI Assistant.",
                        created_at: new Date().toISOString()
                    }]);
                    setIsTyping(false);
                    return;
                }

                const userData = JSON.parse(userDataString);
                const token = userData?.token;
                
                if (!token || token === 'null' || token === 'undefined') {
                    setMessages(prev => [...prev, {
                        sender_role: 'bot',
                        message: "⚠️ Your session has expired. Please log in again.",
                        created_at: new Date().toISOString()
                    }]);
                    setIsTyping(false);
                    return;
                }

                const response = await fetch('http://localhost:3000/api/ai/chat', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ message: text })
                });

                const data = await response.json();

                setMessages(prev => [...prev, {
                    sender_role: 'bot',
                    message: data.reply || "Sorry, I couldn't understand that.",
                    created_at: new Date().toISOString()
                }]);
            } catch (error) {
                console.error("AI Error:", error);
                setMessages(prev => [...prev, {
                    sender_role: 'bot',
                    message: "⚠️ Error connecting to AI server.",
                    created_at: new Date().toISOString()
                }]);
            } finally {
                setIsTyping(false);
            }

        } else {
            if (socketRef.current && bookingId) {
                await socketRef.current.emit("send_message", { 
                    room: bookingId, 
                    message: text, 
                    sender_role: userRole 
                });
            }
        }
    };

    return (
        <Paper elevation={0} sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: '#f5f5f5' }}>
            
            {/* --- HEADER --- */}
            <Box sx={{ p: 2, bgcolor: 'white', borderBottom: '1px solid #e0e0e0', display: 'flex', alignItems: 'center', gap: 2, boxShadow: '0px 2px 4px rgba(0,0,0,0.02)' }}>
                <Avatar sx={{ bgcolor: mode === 'ai' ? '#d32f2f' : (connected ? 'primary.main' : 'warning.main'), width: 40, height: 40 }}>
                    {mode === 'ai' ? <SmartToyIcon /> : <SupportAgentIcon />}
                </Avatar>
                <Box>
                    <Typography variant="subtitle1" fontWeight="bold" color="text.primary">
                        {mode === 'ai' ? 'AI Assistant' : (userRole === 'operator' ? `Booking #${bookingId}` : 'Trip Support')}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                        {mode === 'ai' ? 'Always Online' : (connected ? 'Online' : 'Connecting...')}
                    </Typography>
                </Box>
            </Box>

            {/* --- CHAT AREA --- */}
            <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
                
                {messages.length === 0 && !isTyping && (
                     <Box sx={{ textAlign: 'center', mt: 4, opacity: 0.7 }}>
                        {mode === 'ai' ? <SmartToyIcon sx={{ fontSize: 40, mb: 1 }} /> : <SupportAgentIcon sx={{ fontSize: 40, mb: 1 }} />}
                        <Typography variant="body2" color="text.secondary">
                             {mode === 'ai' ? "Ask me anything!" : "Start a conversation"}
                        </Typography>
                     </Box>
                )}

                {messages.map((msg, index) => {
                    const me = isMe(msg.sender_role);
                    return (
                        <Box key={index} sx={{ display: 'flex', justifyContent: me ? 'flex-end' : 'flex-start', mb: 0.5 }}>
                            <Paper 
                                elevation={1}
                                sx={{ 
                                    p: 1.5, maxWidth: '75%',
                                    bgcolor: me ? 'primary.main' : 'white', 
                                    color: me ? 'white' : 'text.primary',
                                    borderRadius: 2,
                                    position: 'relative'
                                }}
                            >
                                <Typography variant="body1" sx={{ fontSize: '0.95rem', lineHeight: 1.4 }}>
                                    {msg.message}
                                </Typography>
                                <Typography variant="caption" sx={{ display: 'block', textAlign: 'right', fontSize: '0.65rem', mt: 0.5, color: me ? 'rgba(255,255,255,0.7)' : 'text.secondary' }}>
                                    {msg.created_at ? dayjs(msg.created_at).format('h:mm A') : '...'}
                                </Typography>
                            </Paper>
                        </Box>
                    );
                })}

                {/* --- TYPING INDICATOR (CLEANED UP) --- */}
                {isTyping && (
                    <Box sx={{ display: 'flex', justifyContent: 'flex-start', mb: 1 }}>
                        <Paper sx={{ p: 1.5, bgcolor: 'white', borderRadius: 2 }}>
                            <Box sx={{ display: 'flex', gap: 0.5 }}>
                                {/* Styles are now in ChatWindow.css */}
                                <div className="typing-dot">•</div>
                                <div className="typing-dot">•</div>
                                <div className="typing-dot">•</div>
                            </Box>
                        </Paper>
                    </Box>
                )}
                
                <div ref={messagesEndRef} />
            </Box>

            {/* --- INPUT AREA --- */}
            <Box sx={{ p: 2, bgcolor: 'white', borderTop: '1px solid #e0e0e0' }}>
                <Paper 
                    component="form" 
                    elevation={0}
                    sx={{ p: '2px 4px', display: 'flex', alignItems: 'center', borderRadius: 3, bgcolor: '#f8f9fa', border: '1px solid #e0e0e0' }}
                    onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
                >
                    <TextField
                        sx={{ ml: 2, flex: 1 }}
                        placeholder={mode === 'ai' ? "Ask AI..." : "Type a message..."}
                        variant="standard"
                        InputProps={{ disableUnderline: true }}
                        value={currentMessage}
                        onChange={(e) => setCurrentMessage(e.target.value)}
                    />
                    <IconButton type="button" color="primary" onClick={sendMessage} disabled={!currentMessage.trim() || isTyping}>
                        <SendIcon />
                    </IconButton>
                </Paper>
            </Box>
        </Paper>
    );
};