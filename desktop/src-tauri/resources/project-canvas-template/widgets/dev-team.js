(() => {
  window.buzzCanvasWidgets = window.buzzCanvasWidgets || {};
  window.buzzCanvasWidgets.devTeam = {
    renderers: {
      activeChannels: renderActiveChannels,
      clientTime: renderClientTime,
      meetings: renderMeetings,
      reviews: renderReviews,
    },
  };

  function renderActiveChannels(data, api) {
    const { element, icon } = api;
    const list = element("div", "active-channels", {
      testId: "project-canvas-active-channels",
    });
    if (data.snapshotState && data.snapshotState !== "ready") {
      list.append(renderSnapshotState(data.snapshotState, "channels", element));
      return list;
    }
    for (const channel of data.channels) {
      const row = element("section", "channel-row", {
        testId: `project-canvas-active-channel-${channel.name}`,
      });
      const details = element("div", "channel-details");
      details.append(
        element("strong", "channel-name", { text: `# ${channel.name}` }),
      );
      const updates = element("ul", "channel-updates", {
        ariaLabel: `${channel.name} updates`,
      });
      channel.updates.forEach((update) => {
        const item = element("li", "", { text: update });
        item.prepend(icon("✓"));
        updates.append(item);
      });
      details.append(updates);
      const people = renderChannelPeople(channel, api);
      row.append(details, people);
      list.append(row);
    }
    return list;
  }

  function renderChannelPeople(channel, { element, state }) {
    const people = element("div", "channel-people", {
      ariaLabel: `${channel.people.length} channel members`,
    });
    channel.people.forEach((active, index) => {
      const inline = active.inlinePerson || {};
      const person = state().data.people[active.id] || {
        color: inline.color || "#64748b",
        name: inline.displayName || inline.name || "Project member",
        pubkey: inline.pubkey || active.id,
      };
      const wrapper = element("span", "active-person", {
        ariaLabel: `${person.name}, channel member`,
        role: "img",
        testId: `project-canvas-active-channel-${channel.name}-person-${index + 1}`,
      });
      wrapper.dataset.pubkey = person.pubkey;
      const safeAvatar =
        typeof inline.avatarDataUrl === "string" &&
        inline.avatarDataUrl.startsWith("data:image/")
          ? inline.avatarDataUrl
          : avatarDataUri(person);
      wrapper.append(
        element("img", "avatar-image", {
          alt: `${person.name} avatar`,
          src: safeAvatar,
          testId: `project-canvas-active-member-${person.pubkey}`,
        }),
      );
      people.append(wrapper);
    });
    return people;
  }

  function avatarDataUri(person) {
    const initials = person.name
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="${person.color}"/><text x="20" y="25" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="700" fill="white">${initials}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function renderReviews(data, { element, resolveAsset }) {
    const section = element("section", "reviews", {
      ariaLabel: "Reviews you are waiting on",
      testId: "project-canvas-reviews",
    });
    const intro = element("header", "reviews-intro");
    intro.append(
      element("div", "", { text: "Waiting on review" }),
      element("strong", "count-badge", { text: `${data.reviews.length} open` }),
    );
    section.append(intro);
    if (data.snapshotState && data.snapshotState !== "ready") {
      section.append(
        renderSnapshotState(data.snapshotState, "reviews", element),
      );
      return section;
    }
    data.reviews.forEach((review, index) => {
      const row = element("article", "review-row", {
        testId: `project-canvas-review-${index + 1}`,
      });
      const summary = element("div", "review-summary");
      summary.append(
        element("span", "review-number", { text: review.displayId }),
        element("strong", "", { text: review.title }),
        element("code", "", { text: review.branch }),
      );
      const status = element("div", "review-status");
      const reviewerName =
        review.agentName ||
        (review.agentPubkey
          ? `${review.agentPubkey.slice(0, 8)}…`
          : "Reviewer");
      status.setAttribute(
        "aria-label",
        `${reviewerName}, ${review.status.toLowerCase()}`,
      );
      const video = element("video", "review-gloopie", {
        "aria-hidden": "true",
        autoplay: "",
        loop: "",
        muted: "",
        playsinline: "",
        poster: resolveAsset(review.poster),
        testId:
          review.status === "Approved"
            ? "project-canvas-review-agent-approved-video"
            : "project-canvas-review-agent-working-video",
      });
      video.dataset.berdAvatarId = `gloopies-${review.avatarId}`;
      video.dataset.decorative = "true";
      video.muted = true;
      video.src = resolveAsset(review.gloopie);
      status.append(
        video,
        element(
          "span",
          `status-pill ${review.status.toLowerCase().replaceAll(" ", "-")}`,
          {
            text: review.status === "Approved" ? "✓" : review.status,
          },
        ),
      );
      row.append(summary, status);
      section.append(row);
    });
    return section;
  }

  function renderSnapshotState(status, noun, element) {
    const messages = {
      empty: `No ${noun} to show`,
      error: `Could not load ${noun}`,
      loading: `Loading ${noun}…`,
      unavailable: `${noun[0].toUpperCase()}${noun.slice(1)} access unavailable`,
    };
    const container = element("div", "snapshot-state", {
      ariaLabel: messages[status],
      text: messages[status],
    });
    container.dataset.snapshotState = status;
    return container;
  }

  function renderClientTime(data, { element }) {
    const section = element("section", "client-time", {
      ariaLabel: "Client time tracking",
      testId: "project-canvas-contractor-time-tracking",
    });
    const summary = element("div", "time-summary");
    summary.append(
      element("p", "eyebrow", { text: "Weekly capacity" }),
      element("strong", "time-total", { text: data.booked }),
      element("span", "muted", { text: ` of ${data.capacity}` }),
    );
    const capacity = element("div", "capacity-bar");
    for (const client of data.clients) {
      const segment = element("span", "capacity-segment");
      segment.style.width = `${client.share}%`;
      segment.style.backgroundColor = client.color;
      capacity.append(segment);
    }
    summary.append(
      capacity,
      element("p", "capacity-note", { text: "77% booked · 9h 15m open" }),
    );
    section.append(summary);
    data.clients.forEach((client) => {
      const row = element("div", "client-row");
      const mark = element("span", "client-mark");
      mark.style.backgroundColor = client.color;
      const copy = element("div", "client-copy");
      copy.append(
        element("strong", "", { text: client.name }),
        element("span", "muted", { text: client.project }),
      );
      row.append(
        mark,
        copy,
        element("strong", "client-hours", { text: client.time }),
      );
      section.append(row);
    });
    return section;
  }

  function renderMeetings(data, api) {
    const { element, icon } = api;
    const section = element("section", "meetings", {
      ariaLabel: "Team meetings",
      testId: "project-canvas-meetings",
    });
    section.append(element("p", "eyebrow", { text: "Previous" }));
    const previous = element("div", "meeting-previous", {
      testId: "project-canvas-meeting-previous",
    });
    const copy = element("div", "meeting-copy");
    copy.append(
      element("strong", "", { text: data.previous.title }),
      element("span", "muted", {
        text: `${data.previous.time} · ${data.previous.duration}`,
      }),
    );
    const actions = element("div", "meeting-actions");
    const notes = element("button", "small-button", {
      text: "Notes",
      type: "button",
    });
    const recording = element("button", "small-button", {
      text: "Recording",
      type: "button",
    });
    notes.addEventListener("click", () => showMeetingNotes(data.previous, api));
    recording.addEventListener("click", () =>
      showMeetingRecording(data.previous, api),
    );
    actions.append(notes, recording);
    previous.append(icon("✓", "success"), copy, actions);
    section.append(
      previous,
      element("p", "eyebrow upcoming-label", { text: "Coming up" }),
    );
    const upcoming = element("ol", "upcoming-meetings", {
      ariaLabel: "Upcoming meetings",
    });
    data.upcoming.forEach((meeting) => {
      const row = element("li", "upcoming-row", {
        testId: "project-canvas-meeting-upcoming",
      });
      const time = element("div", "meeting-time");
      time.append(
        element("strong", "", { text: meeting.day }),
        element("span", "", { text: meeting.time }),
      );
      const details = element("div", "meeting-copy");
      details.append(
        element("strong", "", { text: meeting.title }),
        element("span", "muted", { text: meeting.duration }),
      );
      row.append(
        time,
        details,
        element("span", "scheduled", { text: "Scheduled" }),
      );
      upcoming.append(row);
    });
    section.append(upcoming);
    return section;
  }

  function showMeetingNotes(meeting, { element, showDialog }) {
    const body = element("div", "meeting-detail", {
      testId: "meeting-notes-detail",
    });
    body.append(
      element("p", "", { text: `${meeting.time} · ${meeting.duration}` }),
    );
    const list = element("ul", "notes-list");
    [
      "Ship the Canvas tab in the next desktop release.",
      "Keep project widgets local-only for the demo.",
      "Recheck mobile spacing before the final walkthrough.",
    ].forEach((note) => {
      list.append(element("li", "", { text: note }));
    });
    body.append(list);
    showDialog(`${meeting.title} notes`, body, "meeting-detail-dialog");
  }

  function showMeetingRecording(meeting, { element, showDialog }) {
    const body = element("div", "meeting-detail", {
      testId: "meeting-recording-detail",
    });
    body.append(
      element("p", "", { text: `${meeting.time} · ${meeting.duration}` }),
    );
    const screen = element("div", "recording-screen");
    const play = element("button", "play-button", {
      ariaLabel: "Play recording",
      text: "▶",
      type: "button",
    });
    play.addEventListener("click", () => {
      const playing = play.getAttribute("aria-label") === "Pause recording";
      play.setAttribute(
        "aria-label",
        playing ? "Play recording" : "Pause recording",
      );
      play.textContent = playing ? "▶" : "Ⅱ";
    });
    screen.append(play);
    body.append(
      screen,
      element("p", "recording-time", { text: "00:00 ━━━━━━━━━ 42:18" }),
    );
    showDialog(`${meeting.title} recording`, body, "meeting-detail-dialog");
  }
})();
