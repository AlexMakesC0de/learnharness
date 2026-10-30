"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppleDictationBridge } from "@/src/core";
import type { Dictation, DictationPhase } from "@/components/dictation";
import { useAppleDictationPreference } from "@/components/apple-dictation-preference";
import { setDictationActive } from "@/components/dictation-state";
type Run = {
	bridge: AppleDictationBridge;
	stopped: boolean;
	id: string | null;
	stream: MediaStream | null;
	source: MediaStreamAudioSourceNode | null;
	worklet: AudioWorkletNode | null;
	pending: Uint8Array[];
	queuedBytes: number;
	writes: Promise<void>;
	startup: Promise<void>;
	drain: (() => void) | null;
	stopTask: Promise<void> | null;
	done: Promise<void>;
	resolveDone: () => void;
};
/** The native path shares capture/meter semantics, never the cloud transport. */
export function useNativeDictation({ append, enabled, audioGraph }: {
	append: (text: string) => void;
	enabled: boolean;
	audioGraph: () => {
		ctx: AudioContext;
		module: Promise<void>;
	};
}): Dictation {
	const preference = useAppleDictationPreference(enabled);
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const levelRef = useRef(0), runRef = useRef<Run | null>(null), appendRef = useRef(append);
	appendRef.current = append;
	const cleanup = useCallback((run: Run) => {
		if (runRef.current !== run)
			return;
		runRef.current = null;
		run.drain?.();
		run.drain = null;
		run.stream?.getTracks().forEach(track => track.stop());
		run.stream = null;
		run.source?.disconnect();
		run.worklet?.disconnect();
		run.source = null;
		run.worklet = null;
		run.pending = [];
		void run.bridge.cancel().catch(() => { });
		setDictationActive(false);
		setPhase("idle");
		run.resolveDone();
	}, []);
	const fail = useCallback((run: Run, cause: unknown) => {
		if (runRef.current !== run)
			return;
		setError(cause instanceof Error ? cause.message : "Apple dictation failed.");
		cleanup(run);
	}, [cleanup]);
	const writeFrame = useCallback((run: Run, bytes: Uint8Array) => {
		if (runRef.current !== run)
			return;
		if (run.queuedBytes + bytes.byteLength > 1024 * 1024) {
			fail(run, new Error("Apple speech could not keep up. Stop and try again."));
			return;
		}
		run.queuedBytes += bytes.byteLength;
		if (!run.id) {
			run.pending.push(bytes);
			return;
		}
		run.writes = run.writes.then(async () => {
			if (runRef.current === run && run.id)
				await run.bridge.append(run.id, bytes);
		}).finally(() => { run.queuedBytes -= bytes.byteLength; }).catch(cause => fail(run, cause));
	}, [fail]);
	const start = useCallback(() => {
		if (runRef.current)
			return;
		const bridge = window.lh?.appleDictation;
		if (!bridge) {
			setError("Apple speech is unavailable. Rebuild the Mac desktop app.");
			return;
		}
		let resolveDone!: () => void;
		const done = new Promise<void>(resolve => { resolveDone = resolve; });
		const run: Run = { bridge, stopped: false, id: null, stream: null, source: null, worklet: null, pending: [], queuedBytes: 0, writes: Promise.resolve(), startup: Promise.resolve(), drain: null, stopTask: null, done, resolveDone };
		runRef.current = run;
		setError(null);
		setPhase("connecting");
		setDictationActive(true);
		run.startup = (async () => {
			const locale = await preference.getLanguage();
			if (runRef.current !== run)
				return;
			const caps = await bridge.capabilities();
			if (runRef.current !== run)
				return;
			if (!caps.available)
				throw new Error(caps.error ?? "Apple speech is unavailable on this Mac.");
			const selected = locale === "system" ? caps.defaultLocale : locale;
			if (!caps.locales.some(item => item.id === selected))
				throw new Error("Choose an Apple-supported dictation language in Settings.");
			const ready = bridge.start(locale);
			ready.catch(cause => fail(run, cause));
			const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
			if (runRef.current !== run) {
				stream.getTracks().forEach(track => track.stop());
				return;
			}
			run.stream = stream;
			if (!run.stopped) {
				const { ctx, module } = audioGraph();
				await module;
				if (ctx.state === "suspended")
					await ctx.resume();
				if (runRef.current !== run)
					return;
				if (!run.stopped) {
					const worklet = new AudioWorkletNode(ctx, "pcm-capture");
					run.worklet = worklet;
					worklet.port.onmessage = (event: {
						data: {
							type: string;
							rms?: number;
							buffer?: ArrayBuffer | Int16Array;
						};
					}) => {
						if (runRef.current !== run)
							return;
						const message = event.data;
						if (message.type === "level")
							levelRef.current = message.rms ?? 0;
						else if (message.type === "flushed")
							run.drain?.();
						else if (message.type === "audio" && message.buffer) {
							const frame = message.buffer;
							writeFrame(run, ArrayBuffer.isView(frame) ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) : new Uint8Array(frame));
						}
					};
					run.source = ctx.createMediaStreamSource(stream);
					run.source.connect(worklet);
					worklet.connect(ctx.destination);
				}
			}
			if (run.stopped) {
				run.stream?.getTracks().forEach(track => track.stop());
				run.stream = null;
			}
			const { sessionId } = await ready;
			if (runRef.current !== run)
				return;
			run.id = sessionId;
			const pending = run.pending;
			run.pending = [];
			run.queuedBytes = 0;
			for (const frame of pending)
				writeFrame(run, frame);
			if (!run.stopped)
				setPhase("recording");
		})().catch(cause => fail(run, cause));
	}, [preference.getLanguage, audioGraph, writeFrame, fail]);
	const stop = useCallback(() => {
		const run = runRef.current;
		if (!run || run.stopTask)
			return;
		run.stopped = true;
		if (!run.worklet) {
			cleanup(run);
			return;
		}
		setPhase("stopping");
		run.stream?.getTracks().forEach(track => track.stop());
		run.stream = null;
		run.source?.disconnect();
		run.source = null;
		const worklet = run.worklet;
		let drain: Promise<void> = Promise.resolve();
		if (worklet) {
			drain = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => { run.drain = null; reject(new Error("Could not finish microphone audio. Try dictating again.")); }, 1500);
				run.drain = () => { clearTimeout(timer); run.drain = null; resolve(); };
				worklet.port.postMessage({ type: "flush" });
			});
		}
		run.stopTask = (async () => {
			await drain;
			worklet?.disconnect();
			if (run.worklet === worklet)
				run.worklet = null;
			await run.startup;
			if (runRef.current !== run || !run.id)
				return;
			await run.writes;
			if (runRef.current !== run)
				return;
			const text = await run.bridge.finish(run.id);
			if (runRef.current !== run)
				return;
			if (text.trim())
				appendRef.current(text.trim());
			cleanup(run);
		})().catch(cause => fail(run, cause));
	}, [cleanup, fail]);
	const cancel = useCallback(() => { const run = runRef.current; if (run)
		cleanup(run); }, [cleanup]);
	const finish = useCallback(() => { const run = runRef.current; if (!run)
		return Promise.resolve(); stop(); return run.done; }, [stop]);
	const toggle = useCallback(() => { if (runRef.current)
		stop();
	else
		start(); }, [stop, start]);
	useEffect(() => () => { if (enabled && runRef.current)
		cleanup(runRef.current); }, [enabled, cleanup]);
	return { phase, error, levelRef, active: phase !== "idle", toggle, stop, finish, cancel, clearError: () => setError(null) };
}
