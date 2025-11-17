document.addEventListener("DOMContentLoaded", () => {
  const modeSelect = document.getElementById("mode");
  const docTypeSelect = document.getElementById("docType");
  const userInput = document.getElementById("userInput");
  const submitBtn = document.getElementById("submitBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const clearBtn = document.getElementById("clearBtn");
  const statusEl = document.getElementById("status");
  const chatEl = document.getElementById("chat");

  let lastAnswerText = "";

  // Load doc types from backend
  fetch("/api/doc-schemas")
    .then((res) => res.json())
    .then((data) => {
      if (Array.isArray(data.docTypes)) {
        data.docTypes.forEach((t) => {
          const option = document.createElement("option");
          option.value = t;
          option.textContent = t;
          docTypeSelect.appendChild(option);
        });
      }
    })
    .catch(() => {});

  function appendMessage(role, text) {
    const wrapper = document.createElement("div");
    wrapper.className = `message ${role}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;

    wrapper.appendChild(bubble);
    chatEl.appendChild(wrapper);
    chatEl.scrollTop = chatEl.scrollHeight;

    return bubble;
  }

  function setupThinkingToggle(bubble, fullText) {
    if (!bubble || !fullText) return;
    bubble.dataset.fullText = fullText;
    bubble.dataset.collapsed = "true";
    bubble.textContent = "思考过程（点击展开）";
    bubble.classList.add("thinking-collapsed");

    bubble.addEventListener("click", () => {
      const collapsed = bubble.dataset.collapsed === "true";
      if (collapsed) {
        bubble.textContent = bubble.dataset.fullText || "";
        bubble.dataset.collapsed = "false";
        bubble.classList.remove("thinking-collapsed");
      } else {
        bubble.textContent = "思考过程（点击展开）";
        bubble.dataset.collapsed = "true";
        bubble.classList.add("thinking-collapsed");
      }
      chatEl.scrollTop = chatEl.scrollHeight;
    });
  }

  async function generate() {
    const text = userInput.value.trim();
    if (!text) {
      statusEl.textContent = "请先输入需要处理的内容。";
      return;
    }

    lastAnswerText = "";
    downloadBtn.disabled = true;

    const userBubble = appendMessage("user", text);

    submitBtn.disabled = true;
    clearBtn.disabled = true;
    userInput.disabled = true;
    statusEl.textContent = "正在生成，请稍候…";

    userInput.value = "";

    const thinkingBubble = appendMessage("assistant", "思考中……");
    thinkingBubble.classList.add("thinking");
    let answerBubble = null;

    try {
      const resp = await fetch("/api/generate-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: text,
          mode: modeSelect.value,
          docType: docTypeSelect.value,
        }),
      });

      if (!resp.ok) {
        let errMsg = resp.statusText;
        try {
          const errBody = await resp.json();
          if (errBody && errBody.error) {
            errMsg = errBody.error;
          }
        } catch (_) {
          // ignore JSON parse error
        }
        statusEl.textContent = "生成失败：" + errMsg;
        thinkingBubble.classList.remove("thinking");
        thinkingBubble.textContent = "【生成失败】" + errMsg;
        return;
      }

      if (!resp.body || !resp.body.getReader) {
        const fullText = await resp.text();
        thinkingBubble.classList.remove("thinking");
        thinkingBubble.textContent = fullText || "";
        lastAnswerText = fullText || "";
        downloadBtn.disabled = !lastAnswerText;
        statusEl.textContent =
          "生成完成（浏览器不支持流式显示）。";
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let thinkingText = "";
      let answerText = "";
      let sawReasoning = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const piece = decoder.decode(value, { stream: true });
        if (!piece) continue;

        buffer += piece;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let evt;
          try {
            evt = JSON.parse(trimmed);
          } catch (_) {
            continue;
          }

          if (evt.type === "reasoning") {
            const delta = evt.delta || "";
            if (!delta) continue;
            sawReasoning = true;
            if (thinkingText === "思考中……") {
              thinkingText = "";
            }
            thinkingBubble.classList.add("thinking");
            thinkingText += delta;
            thinkingBubble.textContent = thinkingText;
          } else if (evt.type === "content") {
            const delta = evt.delta || "";
            if (!delta) continue;
            if (!answerBubble) {
              if (!sawReasoning) {
                // 没有单独的思考内容时，复用原气泡作为正式回答
                answerBubble = thinkingBubble;
                answerBubble.classList.remove("thinking");
              } else {
                answerBubble = appendMessage("assistant", "");
              }
            }
            answerText += delta;
            answerBubble.textContent = answerText;
          }

          chatEl.scrollTop = chatEl.scrollHeight;
        }
      }

      if (answerText) {
        lastAnswerText = answerText;
        downloadBtn.disabled = false;
      }

      if (sawReasoning && thinkingText) {
        thinkingBubble.classList.add("thinking");
        setupThinkingToggle(thinkingBubble, thinkingText);
      }

      statusEl.textContent =
        "生成完成，可以从对话气泡中复制内容。";
    } catch (e) {
      console.error(e);
      statusEl.textContent = "请求失败，请检查服务是否已启动。";
      thinkingBubble.classList.remove("thinking");
      thinkingBubble.textContent =
        "【请求失败】请检查服务是否已启动。";
    } finally {
      submitBtn.disabled = false;
      clearBtn.disabled = false;
      userInput.disabled = false;
    }
  }

  submitBtn.addEventListener("click", generate);

  function deriveFilenameFromContent(text) {
    if (!text) return "公文.docx";
    const str = String(text);
    const m =
      str.match(/^[\u3010\[]标题[\u3011\]]([^\n\r]+)/m) ||
      str.match(/^[\u3010\[]\s*标题\s*[\u3011\]]\s*([^\n\r]+)/m) ||
      str.match(/^[\u3010\[]title[\u3011\]]([^\n\r]+)/im);
    let base = "";
    if (m && m[1]) {
      base = m[1].trim();
    }
    if (!base) {
      base = "公文";
    }
    base = base.replace(/[\\\/:*?"<>|]/g, "_");
    return base + ".docx";
  }

  async function downloadWord() {
    if (!lastAnswerText) {
      statusEl.textContent = "当前没有可导出的公文内容。";
      return;
    }

    downloadBtn.disabled = true;
    statusEl.textContent = "正在生成 Word 文件…";

    try {
      const resp = await fetch("/api/export-docx", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: lastAnswerText,
        }),
      });

      if (!resp.ok) {
        let errMsg = resp.statusText;
        try {
          const errBody = await resp.json();
          if (errBody && errBody.error) {
            errMsg = errBody.error;
          }
        } catch (_) {}
        statusEl.textContent = "导出失败：" + errMsg;
        return;
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = deriveFilenameFromContent(lastAnswerText);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      statusEl.textContent = "Word 文件已下载。";
    } catch (e) {
      console.error(e);
      statusEl.textContent = "导出失败，请稍后重试。";
    } finally {
      if (lastAnswerText) {
        downloadBtn.disabled = false;
      }
    }
  }

  downloadBtn.addEventListener("click", downloadWord);

  clearBtn.addEventListener("click", () => {
    chatEl.innerHTML = "";
    statusEl.textContent = "";
    lastAnswerText = "";
    downloadBtn.disabled = true;
    userInput.focus();
  });

  userInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      generate();
    }
  });
});
