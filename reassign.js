/**
 * AUTOMATED REASSIGNMENT SCRIPT (ROOT VERSION)
 * - No npm install required
 * - Uses local service-account.json (same as your autoDeclineRunner.js)
 * - Sanity rotation preserved
 * - Rank + reading language filtering preserved
 * - Creates NEW Sanity doc for replacement
 * - Sends push notifications
 */

const admin = require("firebase-admin");
const fetch = require("node-fetch"); // Node 18 has fetch, but safe fallback
const { createClient } = require("@sanity/client");
const serviceAccount = require("./service-account.json");

/* ---------------------------------------------------------
   1️⃣ Initialize Firebase Admin (root version)
--------------------------------------------------------- */
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

/* ---------------------------------------------------------
   2️⃣ Initialize Sanity Client
--------------------------------------------------------- */
const sanityClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  token: process.env.SANITY_WRITE_TOKEN,
  apiVersion: "2023-05-03",
  useCdn: false,
});

/* ---------------------------------------------------------
   3️⃣ Your Rotation Function (unchanged)
--------------------------------------------------------- */
const getFinalDeaconsArray = (mainArray, serviceArray, selectedRank) => {
  const remaining = mainArray.filter(
    (d) => !serviceArray.some((sd) => sd.deaconName === d.deaconName)
  );

  const shuffledRemaining = remaining.length > 0 ? [...remaining] : [...serviceArray];
  for (let i = shuffledRemaining.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledRemaining[i], shuffledRemaining[j]] = [
      shuffledRemaining[j],
      shuffledRemaining[i],
    ];
  }

  let shuffledAndRanked = [];
  if (selectedRank === "Any") {
    shuffledAndRanked = [...shuffledRemaining];
  } else {
    shuffledAndRanked = shuffledRemaining.filter(
      (d) => d.deaconRank?.rankName === selectedRank
    );
  }

  const served = mainArray.filter((d) =>
    serviceArray.some((sd) => sd.deaconName === d.deaconName)
  );

  let servedRanked = [];
  if (selectedRank === "Any") {
    servedRanked = [...served];
  } else {
    servedRanked = served.filter(
      (d) => d.deaconRank?.rankName === selectedRank
    );
  }

  return [...shuffledAndRanked, ...servedRanked];
};

/* ---------------------------------------------------------
   4️⃣ Core Replacement Logic
--------------------------------------------------------- */
async function reassignDeacon(assignmentDoc) {
  const assignment = assignmentDoc.data();
  console.log("\n🔄 Processing reassignment for Sanity Document:", assignment.sanityDocId);

  /* STEP 1 — Load ORIGINAL Sanity Service Document */
  const original = await sanityClient.fetch(
    `*[_type=="service" && _id==$id][0]{
      serviceDate,
      serviceDay,
      mainEvent,
      subEvent,
      prayer,

      reading->{ _id, readingName },
      language->{ _id, language },
      deaconRank->{ _id, rankName }
    }`,
    { id: assignment.sanityDocId }
  );

  if (!original) {
    console.log("❌ Original Sanity doc not found:", assignment.sanityDocId);
    return;
  }

  const {
    serviceDate,
    mainEvent,
    subEvent,
    prayer,
    reading,
    language,
    deaconRank,
  } = original;

  /* STEP 2 — Get ALL deacons */
  const allDeacons = await sanityClient.fetch(`
    *[_type == "deacon"]{
      _id,
      deaconName,
      email,
      phone,
      readinglanguage,
      deaconRank->{rankName},
      "rankId": deaconRank._ref,
      expoPushToken
    }
  `);

  /* STEP 3 — Filter by SAME required Language */
  const requiredLang = (language?.language || "").trim().toUpperCase();

  const eligibleByLanguage = allDeacons.filter((d) =>
    (d.readinglanguage?.language || "").trim().toUpperCase() === requiredLang
  );

  if (eligibleByLanguage.length === 0) {
    console.log("❌ No deacons match required language:", requiredLang);
    return;
  }

  /* STEP 4 — Load Service History for Rotation */
  const history = await sanityClient.fetch(`
    *[_type == "service"] | order(_createdAt asc){
      _createdAt,
      deaconName
    }
  `);

  /* STEP 5 — Rank + Rotation Filtering */
  const nextList = getFinalDeaconsArray(
    eligibleByLanguage,
    history,
    deaconRank?.rankName || "Any"
  );

  const nextDeacon = nextList[0];
  if (!nextDeacon) {
    console.log("❌ No eligible replacement found.");
    return;
  }

  console.log("👉 Replacement Selected:", nextDeacon.deaconName);

  /* STEP 6 — Create NEW Sanity service document */
  const newDoc = await sanityClient.create({
    _type: "service",

    serviceDate,
    serviceDay: new Date(serviceDate).toLocaleDateString("en-US", {
      weekday: "long",
    }),

    mainEvent,
    subEvent,
    prayer,

    reading: { _ref: reading._id, _type: "reference" },
    language: { _ref: language._id, _type: "reference" },

    deacon: { _ref: nextDeacon._id, _type: "reference" },
    deaconName: nextDeacon.deaconName,
    deaconRank: { _ref: nextDeacon.rankId, _type: "reference" },

    phone: nextDeacon.phone,
    email: nextDeacon.email,

    isAccepted: null,
    isRejected: null,
    noResponse: null,
    hasAttended: null,
  });

  console.log("🆕 New Sanity Replacement Doc:", newDoc._id);

  /* STEP 7 — Create Firestore Assignment for Replacement */
  const newFSId = `${newDoc._id}_${nextDeacon._id}`;

  await db.collection("ServiceAssignments").doc(newFSId).set({
    sanityDocId: newDoc._id,
    serviceDate,

    readingRefId: reading._id,
    languageRefId: language._id,
    rankFilter: deaconRank.rankName,

    deaconId: nextDeacon._id,
    deaconName: nextDeacon.deaconName,
    email: nextDeacon.email,
    expoPushToken: nextDeacon.expoPushToken || null,

    status: "pending",
    invitedAt: Date.now(),
    expiresAt: Date.now() + 48 * 60 * 60 * 1000,
  });

  console.log("📌 Firestore Assignment Created:", newFSId);

  /* STEP 8 — Send Push Notification */
  if (nextDeacon.expoPushToken) {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: nextDeacon.expoPushToken,
        title: "New Service Assignment",
        body: `You have been assigned a replacement service.`,
        data: { sanityDocId: newDoc._id },
      }),
    });

    console.log("📨 Notification sent to:", nextDeacon.deaconName);
  }

  console.log("✅ Reassignment Completed");
}

/* ---------------------------------------------------------
   5️⃣ MAIN EXECUTION (Called by GitHub Action)
--------------------------------------------------------- */
(async () => {
  console.log("⏳ Checking for expired assignments...");

  const now = Date.now();

  const snapshot = await db
    .collection("ServiceAssignments")
    .where("status", "==", "pending")
    .where("expiresAt", "<=", now)
    .get();

  if (snapshot.empty) {
    console.log("✨ No expired assignments found.");
    return;
  }

  console.log(`⚠ Found ${snapshot.size} expired assignments`);

  for (const doc of snapshot.docs) {
    const assignment = doc.data();

    /* 1️⃣ Update Firestore */
    await doc.ref.update({
      status: "expired",
      respondedAt: now,
    });

    /* 2️⃣ Update Sanity doc */
    await sanityClient.patch(assignment.sanityDocId)
      .set({ noResponse: true })
      .commit();

    /* 3️⃣ Reassign */
    await reassignDeacon(doc);
  }

  console.log("🏁 All reassignments processed.");
})();
