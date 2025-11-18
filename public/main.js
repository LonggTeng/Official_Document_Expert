document.addEventListener("DOMContentLoaded", () => {
  // 功能区 DOM
  const featureCards = Array.from(
    document.querySelectorAll(".feature-card")
  );
  const qaModule = document.getElementById("qaModule");
  const documentModule = document.getElementById("documentModule");

  // 商务问答模块 DOM
  const qaTypeSelect = document.getElementById("qaType");
  const qaInput = document.getElementById("qaInput");
  const generateQAButton = document.getElementById("generateQA");
  const clearQAButton = document.getElementById("clearQA");
  const copyQAButton = document.getElementById("copyQA");
  const qaOutput = document.getElementById("qaOutput");

  // 公文生成模块 DOM
  const docTypeSelect = document.getElementById("docType");
  const docPrioritySelect = document.getElementById("docPriority");
  const docToneSelect = document.getElementById("docTone");
  const docIssuerInput = document.getElementById("docIssuer");
  const docReceiverInput = document.getElementById("docReceiver");
  const docTitleInput = document.getElementById("docTitle");
  const docContentInput = document.getElementById("docContent");
  const generateDocButton = document.getElementById("generateDoc");
  const downloadDocButton = document.getElementById("downloadDoc");
  const copyDocButton = document.getElementById("copyDoc");
  const docOutput = document.getElementById("docOutput");

  let lastQaText = "";
  let lastDocText = "";

  if (downloadDocButton) {
    downloadDocButton.disabled = true;
  }

  // 辅助函数
  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const iconMap = {
      success: "fa-check-circle",
      error: "fa-circle-exclamation",
      info: "fa-circle-info",
    };
    const icon = iconMap[type] || iconMap.info;

    toast.innerHTML = `
      <i class="fas ${icon} text-sm"></i>
      <span class="text-sm">${message}</span>
    `;

    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(20px)";
      setTimeout(() => toast.remove(), 200);
    }, 2600);
  }

  function setButtonLoading(button, isLoading, textWhenLoading = "处理中…") {
    if (!button) return;
    if (isLoading) {
      if (!button.dataset.originalHtml) {
        button.dataset.originalHtml = button.innerHTML;
      }
      button.disabled = true;
      button.innerHTML = `
        <span class="loading"></span>
        <span class="ml-2">${textWhenLoading}</span>
      `;
    } else {
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
      }
      button.disabled = false;
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderTextAsHtml(text, className) {
    if (!text) {
      return `<p class="text-sm text-gray-400">暂无内容</p>`;
    }
    const safe = escapeHtml(text)
      .split("\n")
      .map((line) => line || "&nbsp;")
      .join("<br>");
    return `<div class="${className}">${safe}</div>`;
  }

  async function streamGenerate({ input, mode, docType, onContent }) {
    const payload = {
      input,
      mode: mode || "auto",
      docType: docType || "auto",
    };

    const resp = await fetch("/api/generate-stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      let errMsg = resp.statusText || "请求失败";
      try {
        const errBody = await resp.json();
        if (errBody && errBody.error) {
          errMsg = errBody.error;
        }
      } catch (_) {
        // ignore
      }
      throw new Error(errMsg);
    }

    if (!resp.body || !resp.body.getReader) {
      const full = await resp.text();
      onContent && onContent(full || "");
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let raw = "";
    let sawAnyContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;

      raw += chunk;
      buffer += chunk;
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

        if (evt.type === "content" && evt.delta) {
          sawAnyContent = true;
          onContent && onContent(evt.delta);
        }
      }
    }

    if (!sawAnyContent && raw) {
      try {
        const obj = JSON.parse(raw);
        const choice = obj.choices && obj.choices[0];
        const message = choice && choice.message;
        const content = (message && (message.content || "")) || "";
        if (content && onContent) {
          onContent(content);
        }
      } catch (_) {
        onContent && onContent(raw);
      }
    }
  }

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

  async function downloadDocx(content) {
    const resp = await fetch("/api/export-docx", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (!resp.ok) {
      let errMsg = resp.statusText;
      try {
        const errBody = await resp.json();
        if (errBody && errBody.error) {
          errMsg = errBody.error;
        }
      } catch (_) {
        // ignore
      }
      throw new Error(errMsg || "导出失败");
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = deriveFilenameFromContent(content);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // 功能卡片切换逻辑
  featureCards.forEach((card) => {
    card.addEventListener("click", () => {
      const feature = card.dataset.feature;
      featureCards.forEach((c) => {
        c.classList.toggle("active", c === card);
      });
      if (feature === "qa") {
        qaModule?.classList.remove("hidden");
        documentModule?.classList.add("hidden");
      } else if (feature === "document") {
        documentModule?.classList.remove("hidden");
        qaModule?.classList.add("hidden");
      }
    });
  });

  // 商务问答逻辑
  const qaTypeLabel = {
    greeting: "商务问候",
    request: "请求协助",
    apology: "致歉说明",
    thanks: "感谢表达",
    invitation: "邀请函",
    notification: "通知事项",
    inquiry: "业务咨询",
    response: "回复函件",
  };

  async function handleGenerateQA() {
    const raw = qaInput?.value.trim() || "";
    if (!raw) {
      showToast("请先输入您要咨询或表达的内容。", "info");
      qaInput?.focus();
      return;
    }

    const typeKey = qaTypeSelect?.value || "general";
    const typeLabel = qaTypeLabel[typeKey] || "通用商务表述";

    lastQaText = "";
    if (qaOutput) {
      qaOutput.innerHTML =
        '<p class="text-sm text-gray-400">正在生成商务表述，请稍候…</p>';
    }

    setButtonLoading(generateQAButton, true, "生成中…");

    const input = `请作为一名资深商务写作助手，将下面的内容优化为符合商务礼仪、措辞得体的中文表达。\n\n【问题类型】${typeLabel}\n【原始内容】\n${raw}`;

    try {
      await streamGenerate({
        input,
        mode: "商务问答模式",
        docType: "auto",
        onContent(delta) {
          lastQaText += delta;
          if (qaOutput) {
            qaOutput.innerHTML = renderTextAsHtml(
              lastQaText,
              "qa-output-text"
            );
          }
        },
      });
      showToast("生成完成，可复制使用。", "success");
    } catch (e) {
      console.error(e);
      if (qaOutput) {
        qaOutput.innerHTML =
          '<p class="text-sm text-red-500">生成失败，请稍后重试。</p>';
      }
      showToast("生成失败，请检查服务是否已启动。", "error");
    } finally {
      setButtonLoading(generateQAButton, false);
    }
  }

  function handleClearQA() {
    if (qaInput) qaInput.value = "";
    lastQaText = "";
    if (qaOutput) {
      qaOutput.innerHTML =
        '<div class="text-center py-12 text-gray-400">' +
        '<i class="fas fa-comment-dots text-5xl mb-4"></i>' +
        "<p>输入内容后点击生成按钮</p>" +
        '<p class="text-xs mt-2">我们将为您提供专业的商务表述</p>' +
        "</div>";
    }
  }

  async function handleCopyQA() {
    if (!lastQaText) {
      showToast("暂无可复制内容，请先生成。", "info");
      return;
    }
    try {
      await navigator.clipboard.writeText(lastQaText);
      showToast("已复制到剪贴板。", "success");
    } catch (e) {
      console.error(e);
      showToast("复制失败，请手动选择文本复制。", "error");
    }
  }

  generateQAButton?.addEventListener("click", handleGenerateQA);
  clearQAButton?.addEventListener("click", handleClearQA);
  copyQAButton?.addEventListener("click", handleCopyQA);

  qaInput?.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleGenerateQA();
    }
  });

  // 公文生成逻辑
  async function handleGenerateDoc() {
    const docType = docTypeSelect?.value || "通知";
    const priority = docPrioritySelect?.value || "普通";
    const tone = docToneSelect?.value || "正式规范";
    const issuer = docIssuerInput?.value.trim() || "";
    const receiver = docReceiverInput?.value.trim() || "";
    const title = docTitleInput?.value.trim() || "";
    const content = docContentInput?.value.trim() || "";

    if (!content) {
      showToast("请先填写公文正文内容要点。", "info");
      docContentInput?.focus();
      return;
    }

    lastDocText = "";
    if (docOutput) {
      docOutput.innerHTML =
        '<p class="text-sm text-gray-400">正在生成规范公文，请稍候…</p>';
    }
    setButtonLoading(generateDocButton, true, "生成中…");
    if (downloadDocButton) downloadDocButton.disabled = true;

    const metaLines = [];
    metaLines.push(`文种：${docType}`);
    metaLines.push(`紧急程度：${priority}`);
    metaLines.push(`语言风格：${tone}`);
    if (issuer) metaLines.push(`发文单位：${issuer}`);
    if (receiver) metaLines.push(`收文单位：${receiver}`);
    if (title) metaLines.push(`标题：${title}`);

    const input =
      "请根据以下要点，按照系统提示中的规范，生成一份结构完整、可直接用于办公的正式中文公文。\n\n" +
      metaLines.join("\n") +
      "\n\n正文要点：\n" +
      content;

    try {
      await streamGenerate({
        input,
        mode: "公文生成模式",
        docType,
        onContent(delta) {
          lastDocText += delta;
          if (!docOutput) return;
          const contentHtml = `
            <div class="document-preview-inner">
              ${renderTextAsHtml(lastDocText, "doc-output-text")}
            </div>
          `;
          docOutput.innerHTML = contentHtml;
        },
      });

      if (downloadDocButton && lastDocText) {
        downloadDocButton.disabled = false;
      }
      showToast("公文生成完成，可预览或导出 Word。", "success");
    } catch (e) {
      console.error(e);
      if (docOutput) {
        docOutput.innerHTML =
          '<p class="text-sm text-red-500">生成失败，请稍后重试。</p>';
      }
      showToast("生成失败，请检查服务是否已启动。", "error");
    } finally {
      setButtonLoading(generateDocButton, false);
    }
  }

  function handleClearDoc() {
    if (docIssuerInput) docIssuerInput.value = "";
    if (docReceiverInput) docReceiverInput.value = "";
    if (docTitleInput) docTitleInput.value = "";
    if (docContentInput) docContentInput.value = "";
    lastDocText = "";
    if (docOutput) {
      docOutput.innerHTML =
        '<div class="text-center py-12 text-gray-400">' +
        '<i class="fas fa-file-alt text-5xl mb-4"></i>' +
        "<p>填写信息后点击生成按钮</p>" +
        '<p class="text-xs mt-2">预览标准格式的公文</p>' +
        "</div>";
    }
    if (downloadDocButton) downloadDocButton.disabled = true;
  }

  async function handleCopyDoc() {
    if (!lastDocText) {
      showToast("暂无可复制内容，请先生成。", "info");
      return;
    }
    try {
      await navigator.clipboard.writeText(lastDocText);
      showToast("已复制到剪贴板。", "success");
    } catch (e) {
      console.error(e);
      showToast("复制失败，请手动选择文本复制。", "error");
    }
  }

  async function handleDownloadDoc() {
    if (!lastDocText) {
      showToast("暂无可导出的公文内容。", "info");
      return;
    }
    if (downloadDocButton) {
      setButtonLoading(downloadDocButton, true, "导出中…");
    }
    try {
      await downloadDocx(lastDocText);
      showToast("Word 文件已开始下载。", "success");
    } catch (e) {
      console.error(e);
      showToast("导出失败，请稍后重试。", "error");
    } finally {
      if (downloadDocButton) {
        setButtonLoading(downloadDocButton, false);
      }
    }
  }

  generateDocButton?.addEventListener("click", handleGenerateDoc);
  copyDocButton?.addEventListener("click", handleCopyDoc);
  downloadDocButton?.addEventListener("click", handleDownloadDoc);

  const clearDocButton = document.getElementById("clearDoc");
  clearDocButton?.addEventListener("click", handleClearDoc);

  docContentInput?.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleGenerateDoc();
    }
  });
});
