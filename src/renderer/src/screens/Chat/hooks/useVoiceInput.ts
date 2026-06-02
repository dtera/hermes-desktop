import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice input for the chat box.
 *
 * Primary path: the browser SpeechRecognition API, which streams results
 * **live** as the user speaks (interim + final). Fallback (when SpeechRecognition
 * is missing or fails — common in Electron's Chromium, which has no speech
 * backend): record with MediaRecorder and transcribe the clip via the active
 * profile's provider (Groq/OpenAI Whisper) through the main process. The
 * recorder path is batch (transcribes on stop) — Groq has no streaming ASR
 * over HTTP — so live updates only happen on the SpeechRecognition path.
 *
 * `onResult(text, isFinal)` fires with the cumulative transcript: repeatedly
 * (interim) while listening on the live path, and once (final) on the recorder
 * path. The caller renders it into the input live and commits on `isFinal`.
 */
export interface UseVoiceInput {
  /** Whether voice input can run at all (some capture path exists). */
  supported: boolean;
  /** Actively listening / recording. */
  recording: boolean;
  /** Recorded audio is being transcribed (recorder path only). */
  transcribing: boolean;
  /** Last error, surfaced to the user. */
  error: string | null;
  toggle: () => void;
}

// SpeechRecognition is non-standard; the DOM lib doesn't type it.
interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function useVoiceInput(
  onResult: (text: string, isFinal: boolean) => void,
  profile?: string,
): UseVoiceInput {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Keep the latest onResult without re-creating the start callbacks each render.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const SpeechCtor = getSpeechRecognitionCtor();
  const canRecord =
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  const supported = !!SpeechCtor || canRecord;

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  }, []);

  const startMediaRecorder = useCallback(async () => {
    if (!canRecord) {
      setError("Voice input isn't available here.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stopStream();
        recorderRef.current = null;
        setRecording(false);
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const text = await window.hermesAPI.transcribeAudio(
            bytes,
            blob.type,
            profile,
          );
          if (text) onResultRef.current(text, true);
          else setError("No speech detected.");
        } catch (e) {
          setError((e as Error).message || "Transcription failed.");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      setRecording(true);
      setError(null);
    } catch {
      setError("Microphone access was denied or is unavailable.");
      setRecording(false);
    }
  }, [canRecord, profile, stopStream]);

  const startSpeechRecognition = useCallback(() => {
    if (!SpeechCtor) {
      void startMediaRecorder();
      return;
    }
    let gotResult = false;
    const rec = new SpeechCtor();
    rec.lang = navigator.language || "en-US";
    // Live: keep listening across pauses and surface interim words as spoken.
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      gotResult = true;
      let text = "";
      let isFinal = false;
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        text += r[0].transcript;
        isFinal = r.isFinal;
      }
      // Deliver the running transcript every event so the input updates live.
      onResultRef.current(text.trim(), isFinal);
    };
    rec.onerror = (event) => {
      recognitionRef.current = null;
      setRecording(false);
      // Electron's Chromium usually can't reach a speech backend → fall back to
      // recording + server-side transcription transparently.
      if (
        !gotResult &&
        (event.error === "network" ||
          event.error === "service-not-allowed" ||
          event.error === "not-allowed" ||
          event.error === "audio-capture")
      ) {
        void startMediaRecorder();
      }
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setRecording(false);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setRecording(true);
      setError(null);
    } catch {
      recognitionRef.current = null;
      void startMediaRecorder();
    }
  }, [SpeechCtor, startMediaRecorder]);

  const toggle = useCallback(() => {
    if (recording) {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop(); // onstop runs transcription
      } else {
        setRecording(false);
      }
      return;
    }
    if (transcribing) return;
    setError(null);
    if (SpeechCtor) startSpeechRecognition();
    else void startMediaRecorder();
  }, [
    recording,
    transcribing,
    SpeechCtor,
    startSpeechRecognition,
    startMediaRecorder,
  ]);

  // Tear down any live capture on unmount.
  useEffect(
    () => () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* ignore */
      }
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      stopStream();
    },
    [stopStream],
  );

  return { supported, recording, transcribing, error, toggle };
}
