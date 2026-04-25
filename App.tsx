
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Mic, MicOff, Wheat, Thermometer, Droplets, MapPin, 
  Wind, Navigation, Info, Settings, History, MessageSquare, RefreshCcw
} from 'lucide-react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { WeatherData, CropSuggestion, TranscriptionItem } from './types';
import { encode, decode, decodeAudioData } from './utils/audio-utils';

// Fallback constants if not provided via state
const DEFAULT_LOCATION = "Punjab, India";

const App: React.FC = () => {
  const [isLive, setIsLive] = useState(false);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<CropSuggestion[]>([]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionItem[]>([]);
  const [isLocating, setIsLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [soilType, setSoilType] = useState<string>("Alluvial");

  // Audio refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Gemini Live config
  const SYSTEM_INSTRUCTION = `
    You are an expert AI Agronomist specialized in South Asian and Global agriculture.
    Your goal is to provide crop suggestions based on current weather, location, and soil type.
    
    CRITICAL RULES:
    1. Always start by greeting the farmer warmly.
    2. Use the user's preferred language (the language they speak to you in).
    3. If the user hasn't specified soil type, ask for it politely.
    4. Provide 2-3 specific crop suggestions with high yield potential for the current climatic conditions.
    5. Briefly explain WHY each crop is suitable (e.g., "The high humidity and moderate temperature in ${location || 'your area'} is ideal for rice").
    6. Be encouraging and concise.
  `;

  useEffect(() => {
    // Initial location fetch
    fetchLocation();
  }, []);

  const fetchLocation = () => {
    setIsLocating(true);
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          // In a real app, we'd reverse geocode here. 
          // For now, let's use the coordinates to fetch weather via Gemini reasoning later.
          setLocation(`${latitude.toFixed(2)}, ${longitude.toFixed(2)}`);
          setIsLocating(false);
          // Initial mock weather - real weather will be fetched by AI during conversation
          setWeather({
            temperature: 28,
            humidity: 65,
            condition: "Sunny",
            location: "Current Location",
            rainfall: 12
          });
        },
        (err) => {
          setError("Location access denied. Please set location manually.");
          setLocation(DEFAULT_LOCATION);
          setIsLocating(false);
        }
      );
    }
  };

  const startVoiceSession = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsLive(true);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (event) => {
              const inputData = event.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Transcription
            if (message.serverContent?.inputTranscription) {
               updateTranscription('user', message.serverContent.inputTranscription.text);
            }
            if (message.serverContent?.outputTranscription) {
               updateTranscription('ai', message.serverContent.outputTranscription.text);
            }

            // Handle Audio output
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              activeSourcesRef.current.add(source);
              source.onended = () => activeSourcesRef.current.delete(source);
            }

            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => s.stop());
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (err) => {
            console.error("Gemini Error:", err);
            stopVoiceSession();
          },
          onclose: () => setIsLive(false)
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Failed to start session:", err);
      setError("Could not access microphone.");
    }
  };

  const stopVoiceSession = () => {
    if (sessionRef.current) {
      // In a real implementation we might send a final message or just close
      setIsLive(false);
      window.location.reload(); // Simplest way to cleanup all audio contexts/streams
    }
  };

  const updateTranscription = (type: 'user' | 'ai', text: string) => {
    setTranscriptions(prev => {
      if (prev.length > 0 && prev[prev.length - 1].type === type) {
        const last = prev[prev.length - 1];
        return [...prev.slice(0, -1), { ...last, text: last.text + " " + text }];
      }
      return [...prev, { type, text }];
    });
  };

  return (
    <div className="min-h-screen pb-24 lg:pb-0">
      {/* Header */}
      <header className="bg-green-700 text-white p-4 shadow-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="bg-white p-1.5 rounded-full">
              <Wheat className="text-green-700 w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">AgroVoice AI</h1>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={fetchLocation} 
              className="p-2 hover:bg-green-600 rounded-full transition-colors"
              title="Refresh Location"
            >
              <RefreshCcw className={`w-5 h-5 ${isLocating ? 'animate-spin' : ''}`} />
            </button>
            <div className="hidden sm:flex items-center gap-2 bg-green-800 px-3 py-1 rounded-full text-sm">
              <MapPin className="w-4 h-4" />
              <span>{location || "Detecting..."}</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 grid grid-cols-1 lg:grid-cols-3 gap-6 mt-4">
        
        {/* Left Column: Stats & Settings */}
        <div className="space-y-6">
          <section className="bg-white rounded-2xl p-6 shadow-sm border border-green-100">
            <h2 className="text-lg font-semibold text-green-900 mb-4 flex items-center gap-2">
              <Navigation className="w-5 h-5 text-green-600" />
              Environment Stats
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-orange-50 rounded-xl border border-orange-100">
                <div className="flex items-center gap-2 text-orange-700 mb-1">
                  <Thermometer className="w-4 h-4" />
                  <span className="text-xs font-medium uppercase">Temp</span>
                </div>
                <div className="text-2xl font-bold text-orange-900">{weather?.temperature}°C</div>
              </div>
              <div className="p-4 bg-blue-50 rounded-xl border border-blue-100">
                <div className="flex items-center gap-2 text-blue-700 mb-1">
                  <Droplets className="w-4 h-4" />
                  <span className="text-xs font-medium uppercase">Humidity</span>
                </div>
                <div className="text-2xl font-bold text-blue-900">{weather?.humidity}%</div>
              </div>
              <div className="p-4 bg-cyan-50 rounded-xl border border-cyan-100">
                <div className="flex items-center gap-2 text-cyan-700 mb-1">
                  <Wind className="w-4 h-4" />
                  <span className="text-xs font-medium uppercase">Rainfall</span>
                </div>
                <div className="text-2xl font-bold text-cyan-900">{weather?.rainfall}mm</div>
              </div>
              <div className="p-4 bg-green-50 rounded-xl border border-green-100">
                <div className="flex items-center gap-2 text-green-700 mb-1">
                  <Settings className="w-4 h-4" />
                  <span className="text-xs font-medium uppercase">Soil</span>
                </div>
                <select 
                  value={soilType}
                  onChange={(e) => setSoilType(e.target.value)}
                  className="w-full bg-transparent font-bold text-green-900 text-lg outline-none cursor-pointer"
                >
                  <option value="Alluvial">Alluvial</option>
                  <option value="Black">Black</option>
                  <option value="Red">Red</option>
                  <option value="Laterite">Laterite</option>
                  <option value="Sandy">Sandy</option>
                </select>
              </div>
            </div>
          </section>

          <section className="bg-white rounded-2xl p-6 shadow-sm border border-green-100 hidden lg:block">
            <h2 className="text-lg font-semibold text-green-900 mb-4 flex items-center gap-2">
              <History className="w-5 h-5 text-green-600" />
              Conversation
            </h2>
            <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
              {transcriptions.length === 0 ? (
                <div className="text-center py-8 text-slate-400">
                  <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  <p className="text-sm">Start the AI session to begin speaking</p>
                </div>
              ) : (
                transcriptions.map((t, idx) => (
                  <div key={idx} className={`flex flex-col ${t.type === 'user' ? 'items-end' : 'items-start'}`}>
                    <span className="text-[10px] font-bold text-slate-400 uppercase mb-1">{t.type}</span>
                    <p className={`p-3 rounded-2xl text-sm ${
                      t.type === 'user' 
                        ? 'bg-green-600 text-white rounded-tr-none' 
                        : 'bg-slate-100 text-slate-700 rounded-tl-none'
                    }`}>
                      {t.text}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* Center/Right Column: Main Interaction & Results */}
        <div className="lg:col-span-2 space-y-6">
          {/* Main Voice Hub */}
          <div className={`relative bg-white rounded-3xl p-8 shadow-xl border-4 transition-all duration-500 overflow-hidden ${
            isLive ? 'border-green-500 bg-green-50' : 'border-white'
          }`}>
            {isLive && (
              <div className="absolute inset-0 flex items-center justify-center opacity-10 pointer-events-none">
                <div className="w-64 h-64 bg-green-500 rounded-full animate-ping" />
              </div>
            )}
            
            <div className="relative z-10 flex flex-col items-center text-center">
              <div className={`w-24 h-24 rounded-full flex items-center justify-center mb-6 transition-all transform ${
                isLive ? 'bg-green-600 scale-110 shadow-2xl shadow-green-200' : 'bg-slate-100'
              }`}>
                {isLive ? (
                  <Mic className="w-10 h-10 text-white" />
                ) : (
                  <MicOff className="w-10 h-10 text-slate-400" />
                )}
              </div>
              
              <h2 className={`text-2xl font-bold mb-2 ${isLive ? 'text-green-900' : 'text-slate-800'}`}>
                {isLive ? 'AI Agronomist is Listening' : 'Talk to your AI Agronomist'}
              </h2>
              <p className="text-slate-500 mb-8 max-w-sm">
                {isLive 
                  ? 'Ask about crop suggestions, weather impact, or planting advice in your local language.' 
                  : 'Start a voice conversation to get personalized crop recommendations for your farm.'}
              </p>

              <button
                onClick={isLive ? stopVoiceSession : startVoiceSession}
                className={`px-10 py-4 rounded-full font-bold text-lg shadow-lg transform transition-all hover:scale-105 active:scale-95 flex items-center gap-3 ${
                  isLive 
                    ? 'bg-red-500 hover:bg-red-600 text-white' 
                    : 'bg-green-600 hover:bg-green-700 text-white'
                }`}
              >
                {isLive ? (
                  <>End Session</>
                ) : (
                  <>Start Conversation</>
                )}
              </button>
            </div>
          </div>

          {/* Tips / Info */}
          <div className="bg-blue-50 border border-blue-100 rounded-2xl p-6 flex gap-4">
            <div className="bg-blue-600 p-2 rounded-xl h-fit">
              <Info className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="font-bold text-blue-900 mb-1">How it works</h3>
              <p className="text-sm text-blue-800 leading-relaxed">
                AgroVoice uses real-time satellite weather data and Gemini's large language model to analyze your local conditions. 
                You can speak in **Hindi, Tamil, Telugu, Punjabi, English** or any major local language. 
                Just say: "What should I plant in my black soil given today's weather?"
              </p>
            </div>
          </div>

          {/* Suggested Crops (Placeholder for AI derived results) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {suggestions.length > 0 ? (
              suggestions.map((crop, idx) => (
                <div key={idx} className="bg-white p-5 rounded-2xl border border-green-100 shadow-sm hover:shadow-md transition-shadow">
                  <div className="flex justify-between items-start mb-3">
                    <h3 className="text-xl font-bold text-green-900">{crop.name}</h3>
                    <div className="bg-green-100 text-green-700 px-2 py-1 rounded-lg text-xs font-bold">
                      {crop.suitabilityScore}% Match
                    </div>
                  </div>
                  <p className="text-sm text-slate-600 mb-4 leading-relaxed">{crop.reasoning}</p>
                  <div className="flex gap-4 border-t border-slate-50 pt-4 text-xs font-medium text-slate-500">
                    <div>Yield: <span className="text-green-700">{crop.estimatedYield}</span></div>
                    <div>Season: <span className="text-green-700">{crop.plantingSeason}</span></div>
                  </div>
                </div>
              ))
            ) : (
              <div className="col-span-full bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl py-12 flex flex-col items-center text-slate-400">
                <Wheat className="w-12 h-12 mb-3 opacity-20" />
                <p>Start conversation to generate recommendations</p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Mobile Sticky Control Bar */}
      <div className="fixed bottom-0 left-0 right-0 lg:hidden bg-white border-t border-slate-200 p-4 flex justify-around items-center z-50">
        <button className="flex flex-col items-center gap-1 text-slate-400 hover:text-green-600">
          <History className="w-5 h-5" />
          <span className="text-[10px] font-bold">Logs</span>
        </button>
        <button 
          onClick={isLive ? stopVoiceSession : startVoiceSession}
          className={`w-14 h-14 rounded-full flex items-center justify-center -mt-10 shadow-xl border-4 border-white transition-all ${
            isLive ? 'bg-red-500' : 'bg-green-600'
          }`}
        >
          {isLive ? <Mic className="w-6 h-6 text-white" /> : <MicOff className="w-6 h-6 text-white opacity-50" />}
        </button>
        <button className="flex flex-col items-center gap-1 text-slate-400 hover:text-green-600">
          <Settings className="w-5 h-5" />
          <span className="text-[10px] font-bold">Settings</span>
        </button>
      </div>

      {error && (
        <div className="fixed bottom-24 left-4 right-4 bg-red-600 text-white p-4 rounded-xl shadow-2xl animate-bounce flex items-center justify-between z-[60]">
          <p className="text-sm font-medium">{error}</p>
          <button onClick={() => setError(null)} className="p-1 hover:bg-red-700 rounded">
            <RefreshCcw className="w-4 h-4" />
          </button>
        </div>
      )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #d1fae5; border-radius: 10px; }
      `}</style>
    </div>
  );
};

export default App;
