// dsh-plugin-vault-memory — 浏览器半身（GUI 浮卡：概览/捕获/配置）
// 契约（已真源码校准，daily-digest 同款）：
//   window.__ModuleLoader__.load({ id, factory })；factory 内 module.exports = { name, apply }；
//   apply(ctx) 挂载 DOM 并返回 dispose；宿主 dsh-client-modules 依 package.json dsh.client 声明拾取。
// 零依赖：纯 DOM + fetch（相对路径走宿主 webServer 路由），用户文本一律 textContent 渲染。

window.__ModuleLoader__.load({
  id: "dsh-plugin-vault-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var NAME = "dsh-plugin-vault-memory";
    var HEALTH_PATH = "/vault-memory/health";
    var SETTINGS_PATH = "/vault-memory/settings";
    var CAPTURE_PREVIEW = "/vault-memory/capture/preview";
    var CAPTURE_COMMIT = "/vault-memory/capture/commit";
    var POLL_MS = 20000;
    var HIDE_KEY = "dsh-plugin-vault-memory:hidden";
    var ATTR = "data-vm";

    var CSS = [
      "[" + ATTR + "] * { box-sizing: border-box; }",
      "[" + ATTR + "] .vm-btn { cursor:pointer; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.08); color:inherit; border-radius:8px; padding:5px 10px; font-size:12px; }",
      "[" + ATTR + "] .vm-btn:hover { background:rgba(255,255,255,.18); }",
      "[" + ATTR + "] .vm-btn:disabled { opacity:.45; cursor:default; }",
      "[" + ATTR + "] .vm-btn.vm-primary { background:rgba(70,130,220,.55); }",
      "[" + ATTR + "] .vm-btn.vm-danger { background:rgba(200,70,70,.4); }",
      "[" + ATTR + "] input, [" + ATTR + "] textarea { width:100%; background:rgba(0,0,0,.22); border:1px solid rgba(255,255,255,.14); color:inherit; border-radius:6px; padding:5px 7px; font-size:12px; font-family:inherit; }",
      "[" + ATTR + "] textarea { min-height:70px; resize:vertical; }",
      "[" + ATTR + "] .vm-row { display:flex; gap:6px; align-items:center; margin:6px 0; }",
      "[" + ATTR + "] .vm-label { font-size:11px; opacity:.7; margin-top:8px; display:block; }",
      "[" + ATTR + "] .vm-note { white-space:pre-wrap; font-size:11px; opacity:.85; background:rgba(0,0,0,.25); border-radius:8px; padding:8px; max-height:180px; overflow:auto; }",
      "[" + ATTR + "] .vm-tab { cursor:pointer; padding:5px 10px; border-radius:8px 8px 0 0; font-size:12px; opacity:.6; }",
      "[" + ATTR + "] .vm-tab.vm-on { opacity:1; background:rgba(255,255,255,.1); }",
      "[" + ATTR + "] .vm-item { font-size:12px; padding:4px 0; border-bottom:1px dashed rgba(255,255,255,.08); word-break:break-all; }",
    ].join("\n");

    function el(tag, props, children) {
      var node = document.createElement(tag);
      if (props) for (var k in props) node.setAttribute(k, props[k]);
      (children || []).forEach(function (c) {
        if (typeof c === "string") node.appendChild(document.createTextNode(c));
        else if (c) node.appendChild(c);
      });
      return node;
    }

    function fetchJson(path, method, body) {
      var opt = { method: method || "GET", cache: "no-store", headers: {} };
      if (body) {
        opt.headers["content-type"] = "application/json";
        opt.body = JSON.stringify(body);
      }
      return fetch(path, opt).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) {
            var err = new Error((j && j.error && j.error.message) || "HTTP " + r.status);
            err.code = j && j.error && j.error.code;
            throw err;
          }
          return j;
        });
      });
    }

    function apply() {
      if (document.querySelector("[" + ATTR + '="root"]')) {
        console.warn("[dsh-plugin-vault-memory] apply 已存在，跳过重复挂载");
        return function () {};
      }

      var style = el("style", null, [CSS]);
      document.head.appendChild(style);

      // ---- 胶囊 ----
      var host = el("div", { "data-vm": "root" });
      host.style.cssText =
        "position:fixed; right:16px; bottom:16px; z-index:2147482900; font-family:system-ui,'Segoe UI','Microsoft YaHei',sans-serif; user-select:none; color:#E8EBF2;";
      var capsule = el("button", {
        "data-vm": "capsule",
        title: "vault-memory 面板",
        style: "cursor:pointer;border:none;border-radius:999px;padding:8px 12px;background:rgba(24,28,38,.94);border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 18px rgba(0,0,0,.35);color:#E8EBF2;font-size:14px;display:flex;gap:6px;align-items:center;",
      });
      var badge = el("span", { style: "display:none;background:#c0392b;border-radius:8px;padding:0 5px;font-size:11px;color:#fff;" }, [""]);
      capsule.append(el("span", null, ["\uD83D\uDCDA 知识库"]), badge);
      host.appendChild(capsule);

      // ---- 面板 ----
      var panel = el("div", {
        style:
          "display:none;margin-top:8px;width:400px;max-width:calc(100vw - 40px);background:rgba(24,28,38,.96);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.45);overflow:hidden;",
      });
      host.appendChild(panel);

      var tabsBar = el("div", { style: "display:flex;border-bottom:1px solid rgba(255,255,255,.1);padding:6px 8px 0;gap:4px;" });
      var tabOverview = el("div", { "data-vm": "tab", class: "vm-tab vm-on" }, ["概览"]);
      var tabCapture = el("div", { "data-vm": "tab", class: "vm-tab" }, ["捕获"]);
      var tabConfig = el("div", { "data-vm": "tab", class: "vm-tab" }, ["配置"]);
      tabsBar.append(tabOverview, tabCapture, tabConfig);
      panel.appendChild(tabsBar);

      var bodyBox = el("div", { style: "padding:10px 12px 14px;max-height:60vh;overflow:auto;" });
      panel.appendChild(bodyBox);

      // ================= 概览 =================
      var healthBox = el("div", null, []);
      bodyBox.appendChild(healthBox);
      var lastHealth = { vaults: [] };

      function renderHealth() {
        healthBox.textContent = "";
        if (!lastHealth.enabled) {
          healthBox.appendChild(el("div", { class: "vm-item" }, ["插件未启用（配置里打开 enabled）"]));
          return;
        }
        if (!lastHealth.vaults || lastHealth.vaults.length === 0) {
          healthBox.appendChild(el("div", { class: "vm-item" }, ["未配置任何 vault：切到「配置」标签添加库路径。"]));
          return;
        }
        var errors = 0;
        lastHealth.vaults.forEach(function (v) {
          var head = el("div", { style: "font-weight:700;margin:6px 0 2px;" }, [v.label + " — " + v.path]);
          healthBox.appendChild(head);
          if (v.error || !v.ready) {
            errors++;
            healthBox.appendChild(el("div", { class: "vm-item" }, ["⚠ " + (v.error || "索引未就绪")]));
            return;
          }
          var line = "已索引 " + v.notes + " 篇笔记";
          if (v.brokenLinks > 0) line += " · 断链 " + v.brokenLinks;
          if (v.recent && v.recent.length) line += " · 近 7 天 " + v.recent.length + " 篇更新";
          healthBox.appendChild(el("div", { class: "vm-item" }, [line]));
          (v.recent || []).slice(0, 5).forEach(function (r) {
            healthBox.appendChild(el("div", { class: "vm-item", style: "padding-left:12px;font-size:11px;opacity:.75;" }, [r.path]));
          });
        });
        badge.textContent = String(errors);
        badge.style.display = errors > 0 ? "" : "none";
      }

      function refreshHealth() {
        fetchJson(HEALTH_PATH)
          .then(function (j) {
            lastHealth = j;
            renderHealth();
          })
          .catch(function () {
            if (lastHealth.vaults.length === 0) {
              healthBox.textContent = "";
              healthBox.appendChild(el("div", { class: "vm-item" }, ["服务未响应（web 宿主未加载插件？）"]));
            }
          });
      }
      refreshHealth();

      // ================= 捕获 =================
      var capBox = el("div", null, []);
      var capTitle = el("input", { placeholder: "标题（将作为文件名）" });
      var capFolder = el("input", { placeholder: "目录（留空用默认 Captures）" });
      var capBody = el("textarea", { placeholder: "markdown 正文…" });
      var capTagInput = el("input", { placeholder: "标签，逗号分隔（可选）" });
      var capOut = el("div", {});
      var capSave = el("button", { class: "vm-btn vm-primary", disabled: "" }, ["保存到库"]);

      function selectedVault() {
        var first = lastHealth.vaults && lastHealth.vaults.length ? lastHealth.vaults[0] : null;
        return first ? first.label : undefined;
      }
      function capPayload() {
        return {
          vault: selectedVault(),
          title: capTitle.value,
          body: capBody.value,
          folder: capFolder.value.trim() || undefined,
          tags: capTagInput.value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
        };
      }
      capSave.addEventListener("click", function () {
        capOut.textContent = "保存中…";
        capSave.disabled = true;
        fetchJson(CAPTURE_COMMIT, "POST", capPayload())
          .then(function (j) {
            capOut.textContent = "已保存：" + j.path;
            refreshHealth();
          })
          .catch(function (e) {
            capOut.textContent = "保存失败：" + e.message;
          })
          .finally(function () {
            capSave.disabled = false;
          });
      });

      capBody.addEventListener("input", function () {
        capOut.textContent = "";
      });
      capTitle.addEventListener("input", function () {
        capOut.textContent = "";
      });

      function showPreview() {
        capOut.textContent = "预览中…";
        capSave.disabled = true;
        fetchJson(CAPTURE_PREVIEW, "POST", capPayload())
          .then(function (j) {
            var pre = el("div", { class: "vm-note" });
            pre.appendChild(document.createTextNode("路径: " + j.path + "\n\n" + j.note));
            capOut.textContent = "";
            capOut.appendChild(pre);
            capSave.disabled = false;
          })
          .catch(function (e) {
            capOut.textContent = "预览失败：" + e.message + (e.code === "NOTE_EXISTS" ? "（同名笔记已存在，请换标题或目录）" : "");
          });
      }

      capBox.appendChild(el("label", { class: "vm-label" }, ["标题 *"]));
      capBox.appendChild(capTitle);
      capBox.appendChild(el("label", { class: "vm-label" }, ["目录（vault 内相对路径）"]));
      capBox.appendChild(capFolder);
      capBox.appendChild(el("label", { class: "vm-label" }, ["正文 markdown *"]));
      capBox.appendChild(capBody);
      capBox.appendChild(el("label", { class: "vm-label" }, ["标签"]));
      capBox.appendChild(capTagInput);
      var capRow = el("div", { class: "vm-row", style: "margin-top:10px;" });
      var capPreview = el("button", { class: "vm-btn" }, ["预览"]);
      capPreview.addEventListener("click", showPreview);
      capRow.append(capPreview, capSave);
      capBox.appendChild(capRow);
      capBox.appendChild(capOut);

      // ================= 配置 =================
      var cfgBox = el("div", null, []);
      var cfgList = el("div", {}, []);
      var cfgEnabled = el("input", { type: "checkbox" });
      var cfgPath = el("input", { placeholder: "vault 绝对路径，如 D:\\...\\my-vault" });
      var cfgLabel = el("input", { placeholder: "标签（可选）" });
      var cfgMsg = el("div", {}, []);
      var cfgSave = el("button", { class: "vm-btn vm-primary" }, ["保存配置"]);

      function renderConfig(cfg) {
        cfgList.textContent = "";
        (cfg.vaults || []).forEach(function (v) {
          var row = el("div", { class: "vm-row" });
          row.appendChild(el("span", { class: "vm-item", style: "flex:1;border:none;" }, [v.path + (v.label ? "（" + v.label + "）" : "") + (v.error ? " ⚠ " + v.error : "")]));
          var del = el("button", { class: "vm-btn vm-danger" }, ["移除"]);
          del.addEventListener("click", function () {
            var list = (runtimeConfig.vaults || []).filter(function (x) { return x.path !== v.path; });
            runtimeConfig.vaults = list;
            renderConfig(runtimeConfig);
          });
          row.appendChild(del);
          cfgList.appendChild(row);
        });
      }
      var runtimeConfig = { enabled: true, vaults: [] };

      function loadConfig() {
        fetchJson(SETTINGS_PATH)
          .then(function (j) {
            runtimeConfig = j.config;
            cfgEnabled.checked = runtimeConfig.enabled !== false;
            renderConfig(runtimeConfig);
          })
          .catch(function (e) {
            cfgMsg.textContent = "读取配置失败：" + e.message;
          });
      }

      cfgSave.addEventListener("click", function () {
        cfgSave.disabled = true;
        fetchJson(SETTINGS_PATH, "POST", {
          enabled: cfgEnabled.checked,
          vaults: runtimeConfig.vaults,
        })
          .then(function (j) {
            cfgMsg.textContent = "已保存并生效。";
            runtimeConfig = j.config;
            renderConfig(runtimeConfig);
            refreshHealth();
            loadConfig();
          })
          .catch(function (e) {
            cfgMsg.textContent = "保存失败：" + e.message;
          })
          .finally(function () {
            cfgSave.disabled = false;
          });
      });

      var addBtn = el("button", { class: "vm-btn" }, ["添加"]);
      addBtn.addEventListener("click", function () {
        var p = cfgPath.value.trim();
        if (!p) {
          cfgMsg.textContent = "请输入 vault 路径";
          return;
        }
        var dup = (runtimeConfig.vaults || []).some(function (v) { return v.path === p; });
        if (dup) {
          cfgMsg.textContent = "该路径已存在";
          return;
        }
        runtimeConfig.vaults.push({ path: p, label: cfgLabel.value.trim() || undefined });
        cfgPath.value = "";
        cfgLabel.value = "";
        cfgMsg.textContent = "";
        renderConfig(runtimeConfig);
      });

      cfgBox.appendChild(el("div", { class: "vm-item", style: "border:none;font-size:12px;" }, ["修改立即写入 settings.yaml 并重建索引。"]));
      var enRow = el("div", { class: "vm-row" });
      enRow.append(cfgEnabled, el("span", null, ["启用插件"]));
      cfgBox.appendChild(enRow);
      cfgBox.appendChild(cfgList);
      cfgBox.appendChild(el("label", { class: "vm-label" }, ["新增库"]));
      cfgBox.appendChild(cfgPath);
      cfgBox.appendChild(cfgLabel);
      var addRow = el("div", { class: "vm-row" });
      addRow.append(addBtn, cfgSave);
      cfgBox.appendChild(addRow);
      cfgBox.appendChild(cfgMsg);
      loadConfig();

      // ================= tab 切换 =================
      var boxes = { overview: healthBox, capture: capBox, config: cfgBox };
      bodyBox.appendChild(capBox);
      bodyBox.appendChild(cfgBox);
      capBox.style.display = "none";
      cfgBox.style.display = "none";

      function showTab(which) {
        tabOverview.classList.toggle("vm-on", which === "overview");
        tabCapture.classList.toggle("vm-on", which === "capture");
        tabConfig.classList.toggle("vm-on", which === "config");
        boxes.overview.style.display = which === "overview" ? "" : "none";
        boxes.capture.style.display = which === "capture" ? "" : "none";
        boxes.config.style.display = which === "config" ? "" : "none";
        if (which === "capture") refreshHealth();
        if (which === "config") loadConfig();
      }
      tabOverview.addEventListener("click", function () { showTab("overview"); });
      tabCapture.addEventListener("click", function () { showTab("capture"); });
      tabConfig.addEventListener("click", function () { showTab("config"); });

      // ================= 收起 / 展开 / 清理 =================
      var hidden = false;
      try {
        hidden = localStorage.getItem(HIDE_KEY) === "1";
      } catch (e) {}
      function syncHidden() {
        panel.style.display = hidden ? "none" : "";
      }
      capsule.addEventListener("click", function () {
        hidden = !hidden;
        try {
          if (hidden) localStorage.setItem(HIDE_KEY, "1");
          else localStorage.removeItem(HIDE_KEY);
        } catch (e) {}
        syncHidden();
        if (!hidden) {
          refreshHealth();
          loadConfig();
        }
      });
      syncHidden();

      // ================= 挂载到页面 =================
      function mount() {
        if (!host.isConnected) {
          document.body.appendChild(host);
        }
      }
      if (document.body) mount();
      else document.addEventListener("DOMContentLoaded", mount, { once: true });

      var pollTimer = setInterval(refreshHealth, POLL_MS);
      renderHealth();

      return function dispose() {
        clearInterval(pollTimer);
        host.remove();
        style.remove();
      };
    }

    module.exports = { name: NAME, apply: apply };
    return module.exports;
  },
});
