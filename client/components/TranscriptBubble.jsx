import React from "react";

export default function TranscriptBubble({ text, sender = "user" }) {
  const alignment = sender === "user" ? "items-start" : "items-end";
  const bubbleStyle =
    sender === "user"
      ? "bg-white text-black rounded-xl rounded-tl-none"
      : "bg-gray-100 text-black rounded-xl rounded-tr-none";

  return (
    <div className={`w-full flex ${alignment} px-2`}>
      <div
        className={`px-4 py-2 shadow-sm border border-gray-200 ${bubbleStyle} max-w-[80%]`}
      >
        {text}
      </div>
    </div>
  );
}
