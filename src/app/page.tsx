"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState("Initializing...");
  const socketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const [transcriptions, setTranscriptions] = useState<{ role: string; text: string }[]>([]);
  const [volume, setVolume] = useState(0);

  const addTranscription = useCallback((role: string, text: string) => {
    setTranscriptions((prev) => [...prev.slice(-10), { role, text }]);
  }, []);

  const playRawPcm = useCallback(async (base64Data: string) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }

    const audioCtx = audioContextRef.current;

    try {
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Int16Array(len / 2);
      
      for (let i = 0; i < len; i += 2) {
        bytes[i / 2] = binaryString.charCodeAt(i) | (binaryString.charCodeAt(i + 1) << 8);
      }

      const float32Data = new Float32Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        float32Data[i] = bytes[i] / 32768.0;
      }

      // Gemini Live API output is 24kHz
      const audioBuffer = audioCtx.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);

      // Scheduling to prevent stuttering (Queueing)
      const currentTime = audioCtx.currentTime;
      if (nextStartTimeRef.current < currentTime) {
        nextStartTimeRef.current = currentTime + 0.05; // Small buffer
      }

      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += audioBuffer.duration;
    } catch (err) {
      console.error("Error playing audio:", err);
    }
  }, []);

  const sendVideoFrame = useCallback(() => {
    if (!canvasRef.current || !videoRef.current || !socketRef.current) return;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    const context = canvas.getContext("2d");

    if (context && video.readyState >= 2) {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const base64Image = canvas.toDataURL("image/jpeg", 0.4).split(",")[1];

      const videoMessage = {
        realtimeInput: {
          video: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
      };
      if (socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify(videoMessage));
      }
    }
  }, []);

  useEffect(() => {
    let audioProcessor: ScriptProcessorNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;

    async function setupMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: true,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        source = audioCtx.createMediaStreamSource(stream);
        audioProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
        
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const dataArray = new Uint8Array(analyser.frequencyBinCount || 128);

        source.connect(analyser);
        analyser.connect(audioProcessor);
        audioProcessor.connect(audioCtx.destination);

        audioProcessor.onaudioprocess = (e) => {
          const inputData = e.inputBuffer.getChannelData(0);
          
          analyser.getByteFrequencyData(dataArray);
          const sum = dataArray.reduce((a, b) => a + b, 0);
          setVolume(sum / dataArray.length);

          const pcmData = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
          }

          const base64Audio = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));

          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              realtimeInput: {
                audio: {
                  data: base64Audio,
                  mimeType: "audio/pcm;rate=16000"
                }
              }
            }));
          }
        };

        setStatus("Media active. Connecting to relay...");
        connectWebSocket();
      } catch (err) {
        console.error("Error accessing media:", err);
        setStatus("Error: Could not access camera/mic.");
      }
    }

    function connectWebSocket() {
      const socket = new WebSocket("wss://nonfeasibly-unbesmirched-micheal.ngrok-free.dev");
      socketRef.current = socket;

      socket.onopen = () => {
        setIsConnected(true);
        setStatus("Connected to Gemini Live Relay");
        startStreaming();
      };

      socket.onmessage = async (event) => {
        try {
          let data = event.data;
          if (data instanceof Blob) {
            data = await data.text();
          }
          const response = JSON.parse(data);
          
          if (response.serverContent) {
            const serverContent = response.serverContent;
            if (serverContent.modelTurn?.parts) {
              for (const part of serverContent.modelTurn.parts) {
                if (part.inlineData) {
                  playRawPcm(part.inlineData.data);
                }
              }
            }
            if (serverContent.inputTranscription) {
              addTranscription("User", serverContent.inputTranscription.text);
            }
            if (serverContent.outputTranscription) {
              addTranscription("Gemini", serverContent.outputTranscription.text);
            }
          }
        } catch (e) {
          console.error("Error parsing message:", e);
        }
      };

      socket.onclose = () => {
        setIsConnected(false);
        setStatus("Disconnected from server");
      };

      socket.onerror = (error) => {
        console.error("WebSocket error:", error);
        setStatus("Error: Connection failed.");
      };
    }

    function startStreaming() {
      const interval = setInterval(() => {
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          sendVideoFrame();
        }
      }, 700); // Throttled for stability
      return () => clearInterval(interval);
    }

    setupMedia();

    return () => {
      socketRef.current?.close();
      audioProcessor?.disconnect();
      source?.disconnect();
    };
  }, [addTranscription, playRawPcm, sendVideoFrame]);

  return (
    <div className="flex flex-col h-screen max-h-screen bg-black text-white p-2 sm:p-4 font-sans overflow-hidden">
      <header className="shrink-0 mb-2 sm:mb-6 text-center">
        <h1 className="text-xl sm:text-3xl font-bold tracking-tight text-white flex items-center justify-center gap-2">
          <span className="w-2 h-2 sm:w-3 sm:h-3 bg-red-500 rounded-full animate-pulse" />
          Gemini Live
        </h1>
        <p className={`text-[10px] sm:text-xs mt-1 font-mono uppercase tracking-widest ${isConnected ? "text-green-500" : "text-zinc-500"}`}>
          {status}
        </p>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row gap-2 sm:gap-6 w-full max-w-5xl mx-auto min-h-0">
        {/* Camera Feed */}
        <div className="flex-[3] lg:flex-1 relative group min-h-0">
          <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl blur opacity-20 group-hover:opacity-40 transition duration-1000"></div>
          <div className="relative h-full w-full rounded-xl overflow-hidden bg-zinc-900 border border-white/10 shadow-2xl">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            <canvas ref={canvasRef} width="640" height="480" className="hidden" />
            
            {/* Audio Meter Overlay */}
            <div className="absolute bottom-2 left-2 right-2 flex items-center gap-2 bg-black/40 backdrop-blur-md p-1.5 rounded-lg border border-white/10">
              <div className="text-[8px] font-bold uppercase tracking-tighter text-zinc-400">Mic</div>
              <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-blue-500 transition-all duration-75"
                  style={{ width: `${Math.min(100, volume * 1.5)}%` }}
                />
              </div>
            </div>

            {!isConnected && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
                <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mb-3" />
                <p className="text-xs font-medium text-zinc-400">Connecting...</p>
              </div>
            )}
          </div>
        </div>

        {/* Interaction Log */}
        <div className="flex-1 lg:w-72 flex flex-col bg-zinc-900/50 rounded-xl border border-white/5 p-3 min-h-0">
          <h2 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Conversation</h2>
          <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-hide">
            {transcriptions.length === 0 && (
              <div className="h-full flex items-center justify-center text-center">
                <p className="text-zinc-600 text-[10px] italic px-4">
                  Gemini is listening...
                </p>
              </div>
            )}
            {transcriptions.map((t, i) => (
              <div key={i} className={`flex flex-col ${t.role === "User" ? "items-end" : "items-start"}`}>
                <div className={`max-w-[90%] p-2.5 rounded-xl text-xs ${
                  t.role === "User" 
                    ? "bg-blue-600 text-white rounded-tr-none" 
                    : "bg-zinc-800 text-zinc-200 rounded-tl-none border border-white/5"
                }`}>
                  {t.text}
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      <footer className="shrink-0 mt-2 text-center text-[8px] text-zinc-600 font-mono">
        {isConnected ? "CONNECTED" : "OFFLINE"} | 24KHZ | {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </footer>
    </div>
  );
}
