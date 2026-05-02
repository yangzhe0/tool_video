const state = {
  items: [],
  categories: [],
  page: 1,
  pageSize: 24,
  currentCategories: [],
  query: "",
  sort: "time",
  randomSeed: "",
  rebuildingDurations: false,
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
let playerGuardTimer = null;
const SORT_OPTIONS = [
  { value: "time", label: "更新" },
  { value: "name", label: "名称" },
  { value: "size", label: "大小" },
  { value: "duration", label: "片长" },
  { value: "random", label: "随机" },
];

function buildVideoRecord(item) {
  const thumbnailVersion = Number.isFinite(item.thumbnail_modified_time)
    ? `&v=${Math.floor(item.thumbnail_modified_time)}`
    : "";
  return {
    ...item,
    duration: Number(item.duration) || 0,
    thumbnail_url: item.thumbnail ? `/thumbnail/${encodeMediaPath(item.thumbnail)}?w=480${thumbnailVersion}` : "",
    media_url: `/media/${encodeMediaPath(item.path)}`,
  };
}

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

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

function encodeMediaPath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function updateSummary(total = null) {
  const categoryLabel = state.currentCategories.length > 0
    ? state.currentCategories.join(" + ")
    : "全部";
  const queryLabel = state.query ? ` · 搜索“${state.query}”` : "";
  const countLabel = total === null ? `${state.items.length} 条` : `${state.items.length} / ${total} 条`;
  const stats = state.stats
    ? ` · ${state.stats.category_count} 个标签 · ${formatCompactSize(state.stats.total_size)}`
    : "";
  elements.summary.textContent = `${categoryLabel}${queryLabel} · ${countLabel}${stats}`;
}

function createRandomSeed() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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
            const backgroundHost = target.closest(".poster-button");
            if (backgroundHost) {
              backgroundHost.style.setProperty("--poster-bg", `url("${target.dataset.src}")`);
              backgroundHost.classList.add("has-poster");
            }
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

function renameThumbnailPath(thumbnailPath, newVideoPath) {
  if (!thumbnailPath) {
    return "";
  }

  const thumbExtension = thumbnailPath.match(/\.[^/.]+$/)?.[0] || "";
  const videoStem = newVideoPath.replace(/\.[^/.]+$/, "");
  return `${videoStem}${thumbExtension}`;
}

function getSortLabel(sortValue) {
  return SORT_OPTIONS.find((option) => option.value === sortValue)?.label || "更新";
}

function parseVideoNameParts(video) {
  const extension = video.name.match(/\.[^/.]+$/)?.[0] || ".mp4";
  const stem = video.name.replace(/\.[^/.]+$/, "");
  const match = stem.match(/^(\S+)(\s+)(.*)$/);
  if (match && match[1].replace(/^#+/, "").trim() === video.category) {
    return {
      extension,
      stem,
      prefixToken: match[1],
      separator: match[2],
      baseName: match[3].trim() || stem,
    };
  }

  return {
    extension,
    stem,
    prefixToken: "",
    separator: " ",
    baseName: stem,
  };
}

function buildRenamedPath(video, nextStem) {
  const folder = video.path.split("/").slice(0, -1).join("/");
  const extension = video.name.match(/\.[^/.]+$/)?.[0] || ".mp4";
  return folder ? `${folder}/${nextStem}${extension}` : `${nextStem}${extension}`;
}

function applyVideoUpdate(previousPath, updatedVideo) {
  const index = state.items.findIndex((item) => item.path === previousPath);
  if (index >= 0) {
    state.items[index] = updatedVideo;
  }
  const currentCard = elements.grid.querySelector(`.video-card[data-path="${CSS.escape(previousPath)}"]`);
  if (currentCard) {
    currentCard.replaceWith(createCard(updatedVideo));
  }
}

function createCard(video) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".video-card");
  const playButton = fragment.querySelector('[data-role="play"]');
  const titleButton = fragment.querySelector('[data-role="rename-title"]');
  const title = fragment.querySelector(".card-title");
  const tag = fragment.querySelector('[data-role="tag"]');
  const size = fragment.querySelector('[data-role="size"]');
  const duration = fragment.querySelector('[data-role="duration"]');
  const renameCategoryButton = fragment.querySelector('[data-role="rename-category"]');
  const poster = fragment.querySelector(".poster");
  const fallback = fragment.querySelector(".poster-fallback");
  const renameButton = fragment.querySelector('[data-role="rename"]');
  const deleteButton = fragment.querySelector('[data-role="delete"]');

  card.dataset.path = video.path;

  const displayName = cleanName(video);
  title.textContent = displayName || video.name;
  titleButton.title = displayName || video.name;
  tag.textContent = video.category;
  size.textContent = formatSize(video.size);
  duration.textContent = formatDuration(video.duration);

  if (video.thumbnail_url) {
    poster.dataset.src = video.thumbnail_url;
    poster.alt = displayName || video.name;
    poster.classList.remove("hidden");
    fallback.classList.add("hidden");
  }

  playButton.addEventListener("click", () => openPlayer(video, displayName || video.name));
  titleButton.addEventListener("click", () => renameVideo(video));
  renameButton.addEventListener("click", () => renameVideo(video));
  renameCategoryButton.addEventListener("click", (event) => {
    event.stopPropagation();
    renameCategory(video);
  });
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

async function cycleSort() {
  const currentIndex = SORT_OPTIONS.findIndex((option) => option.value === state.sort);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % SORT_OPTIONS.length : 0;
  state.sort = SORT_OPTIONS[nextIndex].value;
  state.randomSeed = state.sort === "random" ? createRandomSeed() : "";
  renderCategoryChips();
  await reloadVideos();
}

function buildChip(label, value) {
  const button = document.createElement("button");
  button.type = "button";
  const isActive = value === ""
    ? state.currentCategories.length === 0
    : state.currentCategories.includes(value);
  button.className = `chip${isActive ? " active" : ""}`;
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (value === "") {
      if (state.currentCategories.length === 0) {
        return;
      }
      state.currentCategories = [];
    } else {
      if (state.currentCategories.includes(value)) {
        state.currentCategories = state.currentCategories.filter((item) => item !== value);
      } else {
        state.currentCategories = [...state.currentCategories, value];
      }
    }

    renderCategoryChips();
    await reloadVideos();
  });
  return button;
}

function buildActionChip(label, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip chip-action";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function renderCategoryChips() {
  elements.chips.innerHTML = "";
  const searchWrap = document.createElement("label");
  searchWrap.className = "search-chip";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "搜索";
  searchInput.autocomplete = "off";
  searchInput.value = state.query;
  searchInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    const nextValue = searchInput.value.trim();
    if (state.query === nextValue) {
      return;
    }
    state.query = nextValue;
    await reloadVideosPreservingScroll();
  });

  searchWrap.appendChild(searchInput);
  elements.chips.appendChild(searchWrap);

  const sortButton = document.createElement("button");
  sortButton.type = "button";
  sortButton.className = "chip";
  sortButton.textContent = getSortLabel(state.sort);
  sortButton.addEventListener("click", async () => {
    await cycleSort();
  });
  elements.chips.appendChild(sortButton);

  elements.chips.appendChild(buildChip("全部", ""));
  state.categories.forEach((category) => {
    const label = `${category.name} ${category.count}`;
    elements.chips.appendChild(buildChip(label, category.name));
  });

  const durationLabel = state.rebuildingDurations ? "计算中..." : "重算时长";
  elements.chips.appendChild(
    buildActionChip(durationLabel, async () => {
      if (state.rebuildingDurations) {
        return;
      }

      state.rebuildingDurations = true;
      renderCategoryChips();
      showToast("开始重算时长");

      try {
        const response = await fetch("/api/durations/rebuild", { method: "POST" });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "重算失败");
        }

        await reloadVideosPreservingScroll();
        showToast(`时长已更新 ${payload.updated}/${payload.total}`);
      } catch (error) {
        showToast(`时长重算失败: ${error.message || error}`);
      } finally {
        state.rebuildingDurations = false;
        renderCategoryChips();
      }
    }, state.rebuildingDurations)
  );
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
  state.currentCategories.forEach((category) => {
    params.append("category", category);
  });
  if (state.query) {
    params.set("q", state.query);
  }
  params.set("sort", state.sort);
  if (state.sort === "random" && state.randomSeed) {
    params.set("random_seed", state.randomSeed);
  }

  try {
    const response = await fetch(`/api/videos?${params.toString()}`);
    const payload = await response.json();
    const items = (payload.items || []).map(buildVideoRecord);

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

async function reloadVideosPreservingScroll() {
  const scrollTop = window.scrollY;
  await reloadVideos();
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: scrollTop, behavior: "auto" });
  });
}

function openPlayer(video, title) {
  if (playerGuardTimer) {
    window.clearTimeout(playerGuardTimer);
    playerGuardTimer = null;
  }

  elements.player.pause();
  elements.player.removeAttribute("src");
  elements.player.load();

  const handlePlayable = () => {
    if (playerGuardTimer) {
      window.clearTimeout(playerGuardTimer);
      playerGuardTimer = null;
    }
  };

  const handlePlayError = () => {
    if (playerGuardTimer) {
      window.clearTimeout(playerGuardTimer);
      playerGuardTimer = null;
    }
  };

  elements.player.onloadeddata = handlePlayable;
  elements.player.onplaying = handlePlayable;
  elements.player.onerror = handlePlayError;
  elements.player.onstalled = handlePlayError;

  elements.player.src = video.media_url;
  elements.player.load();
  elements.playerTitle.textContent = title;
  elements.playerSubtitle.textContent = `${video.category} · ${formatSize(video.size)} · ${formatDuration(video.duration)}`;
  elements.dialog.showModal();

  playerGuardTimer = window.setTimeout(() => {
    handlePlayError();
  }, 8000);

  const playPromise = elements.player.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {
      handlePlayError();
    });
  }
}

function closePlayer(skipClose = false) {
  if (playerGuardTimer) {
    window.clearTimeout(playerGuardTimer);
    playerGuardTimer = null;
  }
  elements.player.pause();
  elements.player.onerror = null;
  elements.player.onstalled = null;
  elements.player.onloadeddata = null;
  elements.player.onplaying = null;
  elements.player.removeAttribute("src");
  elements.player.load();
  if (!skipClose && elements.dialog.open) {
    elements.dialog.close();
  }
}

async function renameVideo(video) {
  const parts = parseVideoNameParts(video);
  const next = window.prompt("请输入新文件名:", parts.baseName);
  if (!next || next.trim() === parts.baseName) {
    return;
  }

  const nextStem = parts.prefixToken
    ? `${parts.prefixToken}${parts.separator}${next.trim()}`
    : next.trim();
  const newRelativePath = buildRenamedPath(video, nextStem);

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

  const updatedVideo = buildVideoRecord({
    ...video,
    name: `${nextStem}${parts.extension}`,
    path: newRelativePath,
    thumbnail: renameThumbnailPath(video.thumbnail, newRelativePath),
  });
  applyVideoUpdate(video.path, updatedVideo);

  showToast("重命名完成");
}

async function renameCategory(video) {
  const parts = parseVideoNameParts(video);
  const currentTag = parts.prefixToken.replace(/^#+/, "") || video.category;
  const nextTag = window.prompt("请输入新标签:", currentTag);
  if (!nextTag || nextTag.trim() === currentTag) {
    return;
  }

  const nextPrefix = parts.prefixToken.startsWith("#") ? `#${nextTag.trim()}` : nextTag.trim();
  const nextStem = parts.baseName ? `${nextPrefix}${parts.separator}${parts.baseName}` : nextPrefix;
  const newRelativePath = buildRenamedPath(video, nextStem);

  const response = await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldName: video.path, newName: newRelativePath }),
  });
  if (!response.ok) {
    const payload = await response.json();
    window.alert(payload.error || "改标签失败");
    return;
  }

  const updatedVideo = buildVideoRecord({
    ...video,
    name: `${nextStem}${parts.extension}`,
    path: newRelativePath,
    category: nextTag.trim(),
    thumbnail: renameThumbnailPath(video.thumbnail, newRelativePath),
  });
  applyVideoUpdate(video.path, updatedVideo);

  showToast("标签已更新");
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

  state.items = state.items.filter((item) => item.path !== video.path);
  state.total = Math.max(0, state.total - 1);
  if (state.stats) {
    state.stats = {
      ...state.stats,
      total_size: Math.max(0, (state.stats.total_size || 0) - video.size),
    };
  }
  const currentCard = elements.grid.querySelector(`.video-card[data-path="${CSS.escape(video.path)}"]`);
  if (currentCard) {
    currentCard.remove();
  }
  updateSummary(state.total);
  setEmptyState();
  syncLoadMore();
  if (elements.dialog.open && elements.player.currentSrc.endsWith(encodeMediaPath(video.path))) {
    closePlayer();
  }

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
