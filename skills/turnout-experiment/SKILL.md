---
name: turnout-experiment
description: Test two or three versions of a website against each other with Turnout and self-hosted Flagsmith Experimentation, read Flagsmith's verdict, and hand the Ship or Revert decision to a person. Use when someone wants to know whether a new release, redesign or branch of their site does better than what's live, without adding code to the app.
---

# Run a release experiment with Turnout

Turnout is a reverse proxy: it sends each visitor to one version of the site by a Flagsmith flag, turns plain HTTP into Flagsmith events, and lets Flagsmith Experimentation decide. **You never edit the app's code, and you never ship.**

## 1. Check what you need

- Docker running, with about 4 GB of memory for it, and Git. `turnout` installed (README, Quick start). If `turnout` is missing, tell the person how to install it; don't install it yourself without asking.
- Two versions of the site, each reachable as a URL (`localhost:3001`, `localhost:3002`), a folder with a Dockerfile, or an image. Ask which is live today: that one is **A**.
- A goal, if they have one: the request that means success, like `POST /signup` returning 2xx. With no goal, versions are judged on page speed.

## 2. Start the test

```sh
turnout compare <A> <B>            # A/B; add a third version for A/B/C
turnout compare <A> <B> --split 20 # only 20% of visitors see the new version
```

It prints the app's address through Turnout and the console's address. Tell the person both. Changing the versions, the split or the goal later starts a new experiment and discards the old data: say so before you do it.

## 3. Get visitors, then read Flagsmith's results

Real visitors are best. For a demo, `turnout simulate --visitors 500` sends labelled pretend visitors into a separate Flagsmith environment. Never present simulated numbers as real users.

```sh
turnout results
```

Report what it says, in its words:

- **"Turnout recommends: ship"**: Flagsmith's credible interval for the new version clears zero, its chance to win is at least 95%, and no safety check is losing.
- **"keep running"**: the interval still crosses zero, or Flagsmith has no result yet. Say how many more visitors it suggests, if it does. Don't call a winner.
- **"revert"**: the new version is worse, or loses a safety check (page speed, server errors, `lcp_ms`, `cls`).

Flagsmith refreshes results at most every 5 minutes; asking again sooner shows the same numbers.

## 4. Stop for a person

Don't run `turnout ship` or `turnout revert`, and don't edit the flag in Flagsmith. Give the person:

1. the recommendation and Flagsmith's numbers (lift, interval, chance to win, each safety check);
2. the command they would run (`turnout ship v2` or `turnout revert`), or the console's Ship and Revert buttons;
3. any caveat: a small sample, an interval near zero, simulated visitors.

Both commands ask for confirmation, and only a person at the terminal can give it.

## Don't

- Don't paste repositories into Try it, or run `turnout compare` on images, that the person hasn't said they trust: Try it builds and runs code on their machine (docs/HOW_IT_WORKS.md, "Try it with your app").
- Don't run `turnout reset`: it wipes Flagsmith's data and the release history.
- Don't change the split or goal mid-test without saying the data restarts.
