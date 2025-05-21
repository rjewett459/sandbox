import { useEffect, useRef, useState } from "react";
import logo from "/assets/logo-small-transparent.png";
import SessionControls from "./SessionControls";
import TranscriptBubble from "./TranscriptBubble";

export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [dataChannel, setDataChannel] = useState(null);
  const [transcriptBubbles, setTranscriptBubbles] = useState([]);
  const [showOverlay, setShowOverlay] = useState(true);
  const [isClient, setIsClient] = useState(false); // ✅ NEW: Tracks client-side rendering
  const peerConnection = useRef(null);
  const audioElement = useRef(null);
  const transcriptContainerRef = useRef(null);

  useEffect(() => {
    setIsClient(true); // ✅ Set to true once on client
  }, []);

  useEffect(() => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
    }
  }, [transcriptBubbles]);

  async function startSession() {
    setShowOverlay(false);

    const tokenResponse = await fetch("/token");
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.client_secret.value;

    const pc = new RTCPeerConnection();

    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => (audioElement.current.srcObject = e.streams[0]);

    const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(ms.getTracks()[0]);

    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch(
      "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      }
    );

    const answer = {
      type: "answer",
      sdp: await sdpResponse.text(),
    };
    await pc.setRemoteDescription(answer);

    peerConnection.current = pc;
  }

  function stopSession() {
    if (dataChannel) dataChannel.close();

    peerConnection.current.getSenders().forEach((sender) => {
      if (sender.track) sender.track.stop();
    });

    if (peerConnection.current) peerConnection.current.close();

    setIsSessionActive(false);
    setDataChannel(null);
    peerConnection.current = null;
  }

  function sendClientEvent(message) {
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();
      dataChannel.send(JSON.stringify(message));
      if (!message.timestamp) message.timestamp = timestamp;
      setEvents((prev) => [message, ...prev]);
    }
  }

  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    };

    setTranscriptBubbles((prev) => [...prev, { text: message, sender: "user" }]);
    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
  }

  useEffect(() => {
    if (dataChannel) {
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) event.timestamp = new Date().toLocaleTimeString();

        setEvents((prev) => [event, ...prev]);

        if (
          event.type === "response.content_part.added" &&
          event.item?.role === "assistant"
        ) {
          const part = event.item.content?.[0];
          if (part?.type === "text" && part.text?.value) {
            setTranscriptBubbles((prev) => [
              ...prev,
              { text: part.text.value, sender: "assistant" },
            ]);
          }
        }
      });

      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
        setTranscriptBubbles([]);

        sendTextMessage(
          "Hey there, it’s great to have you here. Let's chat about Learn Wall Street Academy. You can ask me about almost anything."
        );
      });
    }
  }, [dataChannel]);

  return (
  <>
    {/* ✅ Overlay only shown on client */}
    {isClient && showOverlay && (
      <div
        onClick={startSession}
        className="absolute inset-0 bg-black bg-opacity-60 z-50 flex items-center justify-center cursor-pointer transition-opacity hover:bg-opacity-50"
      >
        <div className="text-center px-6 py-4 bg-white rounded-xl shadow-lg">
          <h2 className="text-xl font-bold mb-2">👋 Tap to talk with Professor Rich</h2>
          <p className="text-sm text-gray-600">He’s ready to answer your questions.</p>
        </div>
      </div>
    )}

    {/* ✅ Nav only shown on client to avoid SSR mismatch */}
    {isClient && (
      <nav className="absolute top-0 left-0 right-0 h-16 flex items-center bg-white z-10">
        <div className="flex items-center gap-4 w-full m-4 pb-2 border-b border-gray-200">
          <img style={{ width: "34px" }} src={logo} />
          <h1 className="text-sm font-semibold">Professor Rich</h1>
        </div>
      </nav>
    )}

    {isClient && (
      <main className="absolute top-16 left-0 right-0 bottom-0 flex flex-col bg-white">
        <div
          ref={transcriptContainerRef}
          className="flex-1 overflow-y-auto px-4 py-6 space-y-3"
        >
          {transcriptBubbles.map((bubble, index) => (
            <TranscriptBubble
              key={index}
              text={bubble.text}
              sender={bubble.sender}
            />
          ))}
        </div>

        <div className="px-3 py-2 border-t border-gray-200 bg-white">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <SessionControls
              startSession={startSession}
              stopSession={stopSession}
              sendClientEvent={sendClientEvent}
              sendTextMessage={sendTextMessage}
              events={events}
              isSessionActive={isSessionActive}
            />
          </div>
        </div>
      </main>
    )}
  </>
);

}
