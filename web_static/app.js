const state = {
  items: [],
  categories: [],
  page: 1,
  pageSize: 24,
  currentCategory: "",
  hasMore: true,
  loading: false,
  total: 0,
  stats: null,
};

const elements = {
  grid: document.getElementById("videoGrid"),
  chips: document.getElementById("categoryChips"),
  summary: document.getElementById("summaryText"),
  empty: document.getElementById("emptyState"),
  loadMore: document.getElementById("loadMoreButton"),
  sentinel: document.getElementById("sentinel"),
  toast: document.getElementById("toast"),
  dialog: document.getElementById("playerDialog"),
  player: document.getElementById("player"),
  playerTitle: document.getElementById("playerTitle"),
  playerSubtitle: document.getElementById("playerSubtitle"),
  closePlayer: document.getElementById("closePlayerButton"),
  template: document.getElementById("videoCardTemplate"),
};

let toastTimer = null;

function formatSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(1)} ${units[index]}`;
}

function cleanName(video) {
  return video.name
    .replace(video.category, "")
    .replace(/^[-_\s]+/, "")
    .replace(/\.[^/.]+$/, "")
    .trim();
}

function formatCompactSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function updateSummary(total = null) {
  const categoryLabel = state.currentCategory ? `#${state.currentCategory}` : "全部";
  const countLabel = total === null ? `${state.items.length} 条` : `${state.items.length} / ${total} 条`;
  const stats = state.stats
    ? ` · ${state.stats.category_count} 个标签 · ${formatCompactSize(state.stats.total_size)}`
    : "";
  elements.summary.textContent = `${categoryLabel} · ${countLabel}${stats}`;
}

function setLoading(next) {
  state.loading = next;
  elements.loadMore.disabled = next;
  elements.loadMore.textContent = next ? "加载中..." : "加载更多";
}

function setEmptyState() {
  const isEmpty = state.items.length === 0 && !state.loading;
  elements.empty.classList.toggle("hidden", !isEmpty);
}

function syncLoadMore() {
  elements.loadMore.classList.toggle("hidden", !state.hasMore);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 1800);
}

let posterObserver = null;

function observePoster(image) {
  if (!image || !image.dataset.src) {
    return;
  }

  if (!posterObserver) {
    posterObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }
          const target = entry.target;
          if (target.dataset.src) {
            target.src = target.dataset.src;
            target.removeAttribute("data-src");
          }
          posterObserver.unobserve(target);
        });
      },
      { rootMargin: "180px 0px" }
    );
  }

  posterObserver.observe(image);
}

function createCard(video) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".video-card");
  const playButton = fragment.querySelector('[data-role="play"]');
  const titleButton = fragment.querySelector('[data-role="rename-title"]');
  const title = fragment.querySelector(".card-title");
  const tag = fragment.querySelector('[data-role="tag"]');
  const size = fragment.querySelector('[data-role="size"]');
  const poster = fragment.querySelector(".poster");
  const fallback = fragment.querySelector(".poster-fallback");
  const renameButton = fragment.querySelector('[data-role="rename"]');
  const deleteButton = fragment.querySelector('[data-role="delete"]');

  const displayName = cleanName(video);
  title.textContent = displayName || video.name;
  titleButton.title = displayName || video.name;
  tag.textContent = `#${video.category}`;
  size.textContent = formatSize(video.size);

  if (video.thumbnail_url) {
    poster.dataset.src = video.thumbnail_url;
    poster.alt = displayName || video.name;
    poster.classList.remove("hidden");
    fallback.classList.add("hidden");
  }

  playButton.addEventListener("click", () => openPlayer(video, displayName || video.name));
  titleButton.addEventListener("click", () => renameVideo(video));
  renameButton.addEventListener("click", () => renameVideo(video));
  deleteButton.addEventListener("click", () => deleteVideo(video));

  observePoster(poster);
  return card;
}

function appendVideos(items) {
  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    fragment.appendChild(createCard(item));
  });
  elements.grid.appendChild(fragment);
}

async function fetchCategories() {
  const response = await fetch("/api/categories");
  const payload = await response.json();
  state.categories = payload.items || [];
  renderCategoryChips();
}

function buildChip(label, value) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chip${state.currentCategory === value ? " active" : ""}`;
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (state.currentCategory === value) {
      return;
    }
    state.currentCategory = value;
    renderCategoryChips();
    await reloadVideos();
  });
  return button;
}

function renderCategoryChips() {
  elements.chips.innerHTML = "";
  elements.chips.appendChild(buildChip("全部", ""));
  state.categories.forEach((category) => {
    const label = `#${category.name} ${category.count}`;
    elements.chips.appendChild(buildChip(label, category.name));
  });
}

async function loadVideos({ reset = false } = {}) {
  if (state.loading) {
    return;
  }

  setLoading(true);
  if (reset) {
    state.page = 1;
    state.items = [];
    state.hasMore = true;
    state.total = 0;
    state.stats = null;
    elements.grid.innerHTML = "";
    updateSummary();
  }

  const params = new URLSearchParams({
    page: String(state.page),
    page_size: String(state.pageSize),
  });
  if (state.currentCategory) {
    params.set("category", state.currentCategory);
  }

  try {
    const response = await fetch(`/api/videos?${params.toString()}`);
    const payload = await response.json();
    const items = (payload.items || []).map((item) => ({
      ...item,
      thumbnail_url: item.thumbnail ? `/thumbnail/${encodeURI(item.thumbnail)}?w=480` : "",
      media_url: `/media/${encodeURI(item.path)}`,
    }));

    state.items.push(...items);
    state.hasMore = Boolean(payload.has_more);
    state.total = payload.total || 0;
    state.stats = payload.stats || null;
    appendVideos(items);
    updateSummary(payload.total);
    syncLoadMore();
    setEmptyState();
  } catch (error) {
    elements.summary.textContent = `加载失败: ${error}`;
  } finally {
    setLoading(false);
  }
}

async function reloadVideos() {
  await loadVideos({ reset: true });
}

function openPlayer(video, title) {
  elements.player.pause();
  elements.player.removeAttribute("src");
  elements.player.load();

  elements.player.src = video.media_url;
  elements.playerTitle.textContent = title;
  elements.playerSubtitle.textContent = `#${video.category} · ${formatSize(video.size)}`;
  elements.dialog.showModal();

  const playPromise = elements.player.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {});
  }
}

function closePlayer(skipClose = false) {
  elements.player.pause();
  elements.player.removeAttribute("src");
  elements.player.load();
  if (!skipClose && elements.dialog.open) {
    elements.dialog.close();
  }
}

async function renameVideo(video) {
  const extension = video.name.match(/\.[^/.]+$/)?.[0] || ".mp4";
  const currentFullName = video.name.replace(/\.[^/.]+$/, "");
  const next = window.prompt("请输入完整新文件名（不含扩展名）:", currentFullName);
  if (!next || next.trim() === currentFullName) {
    return;
  }

  const folder = video.path.split("/").slice(0, -1).join("/");
  const newRelativePath = folder ? `${folder}/${next.trim()}${extension}` : `${next.trim()}${extension}`;

  const response = await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName: video.path, newName: newRelativePath }),
  });
  if (!response.ok) {
    const payload = await response.json();
    window.alert(payload.error || "重命名失败");
    return;
  }

  await fetchCategories();
  await reloadVideos();
  showToast("重命名完成");
}

async function deleteVideo(video) {
  if (!window.confirm("确定要删除此视频吗？")) {
    return;
  }

  const response = await fetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: video.path }),
  });
  if (!response.ok) {
    const payload = await response.json();
    window.alert(payload.error || "删除失败");
    return;
  }

  await fetchCategories();
  await reloadVideos();
  showToast("已移入回收目录");
}

function setupInfiniteScroll() {
  const observer = new IntersectionObserver(
    async (entries) => {
      const entry = entries[0];
      if (!entry.isIntersecting || !state.hasMore || state.loading) {
        return;
      }
      state.page += 1;
      await loadVideos();
    },
    { rootMargin: "240px 0px" }
  );
  observer.observe(elements.sentinel);
}

elements.loadMore.addEventListener("click", async () => {
  if (!state.hasMore || state.loading) {
    return;
  }
  state.page += 1;
  await loadVideos();
});

elements.closePlayer.addEventListener("click", () => closePlayer());
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) {
    closePlayer();
  }
});
elements.dialog.addEventListener("close", () => closePlayer(true));

async function init() {
  await fetchCategories();
  await reloadVideos();
  setupInfiniteScroll();
}

init();
