/**
 * Synthetic timelines for evaluating the agent end to end. Each expectation is a
 * group of alternative phrasings; any one matching counts, so a correct answer
 * worded differently still passes. Times are Europe/Copenhagen capture times.
 */
export type Phrases = string[];
export type ScenarioStep = { at: string; text: string };
export type Probe = {
  at: string;
  question: string;
  /** Every group must appear in the answer (claims, quotes or cited items). */
  mustInclude: Phrases[];
  /** No group may appear in the user's evidence or items the answer cites. */
  mustExclude: Phrases[];
};
export type LedgerCheck = {
  phrases: Phrases;
  status: "open" | "closed";
  requestedBy?: string;
  certainty?: "confirmed" | "unconfirmed";
  /** A commitment the agent must not miss; failing it is the critical metric. */
  commitment: boolean;
  /** Filler that must not survive into the item's title or content. */
  filler?: Phrases;
  /** Acceptable deadlines (YYYY-MM-DD, Copenhagen), any one passes. */
  due?: string[];
  /** Acceptable starts: YYYY-MM-DD, or "YYYY-MM-DD HH:MM" for a set time. */
  start?: string[];
  /** Timing with no date behind it: no dates, the user's words in dueHint. */
  undated?: true;
};
export type Scenario = {
  name: string;
  steps: ScenarioStep[];
  ledger: LedgerCheck[];
  probes: Probe[];
};

export const scenarios: Scenario[] = [
  {
    name: "work-month",
    steps: [
      {
        at: "2026-09-01T09:10:00+02:00",
        text: "Standup notes: Mette asked me to build the onboarding dashboard for the sales team. I said yes but I can't start until after the Q3 release.",
      },
      {
        at: "2026-09-01T12:40:00+02:00",
        text: "Lunch at the new place on Vesterbrogade, great falafel.",
      },
      {
        at: "2026-09-03T15:05:00+02:00",
        text: "Jonas asked if I could review his API design doc by Friday. Told him sure.",
      },
      {
        at: "2026-09-04T08:30:00+02:00",
        text: "Maybe we should replace Jenkins with Forgejo Actions at some point.",
      },
      {
        at: "2026-09-07T10:00:00+02:00",
        text: "I need to book a venue for the team offsite in November.",
      },
      {
        at: "2026-09-08T16:20:00+02:00",
        text: "Reviewed Jonas's API doc and sent him my comments.",
      },
      {
        at: "2026-09-10T11:15:00+02:00",
        text: "Anna from finance wants the Q3 cost report numbers from me before the board meeting on the 25th. I promised I'd send them.",
      },
      {
        at: "2026-09-12T14:00:00+02:00",
        text: "Kristian asked whether I could mentor the new intern. I said I'd think about it.",
      },
      {
        at: "2026-09-15T09:45:00+02:00",
        text: "Jeg har lovet Peter at opdatere wiki-siden om deployment inden udgangen af måneden.",
      },
      {
        at: "2026-09-16T17:40:00+02:00",
        text: "ok so uh Lars came by, and like, he basically asked if I could set up the staging env for the mobile app thing?? and I was like yeah sure, lol, just not this week",
      },
      {
        at: "2026-09-18T13:30:00+02:00",
        text: "Mette says the onboarding dashboard is now top priority for October.",
      },
      {
        at: "2026-09-20T18:05:00+02:00",
        text: "The offsite got cancelled, so I don't need to book a venue anymore.",
      },
      {
        at: "2026-09-22T08:10:00+02:00",
        text: "Note to self: my laptop battery is degrading fast.",
      },
    ],
    ledger: [
      {
        phrases: ["onboarding dashboard"],
        status: "open",
        requestedBy: "Mette",
        commitment: true,
      },
      {
        phrases: ["API design", "API doc"],
        status: "closed",
        requestedBy: "Jonas",
        commitment: true,
      },
      {
        phrases: ["cost report", "Q3 cost"],
        status: "open",
        requestedBy: "Anna",
        commitment: true,
      },
      {
        phrases: ["wiki"],
        status: "open",
        requestedBy: "Peter",
        commitment: true,
      },
      { phrases: ["venue"], status: "closed", commitment: true },
      {
        phrases: ["staging"],
        status: "open",
        requestedBy: "Lars",
        commitment: true,
        filler: ["uh", "lol", "basically", "was like", "yeah sure", "ok so"],
      },
      {
        phrases: ["mentor"],
        status: "open",
        requestedBy: "Kristian",
        certainty: "unconfirmed",
        commitment: true,
      },
    ],
    probes: [
      {
        at: "2026-10-01T09:00:00+02:00",
        question: "What do I have outstanding?",
        mustInclude: [
          ["onboarding dashboard"],
          ["cost report", "Q3 cost"],
          ["wiki"],
          ["mentor", "intern"],
          ["staging"],
        ],
        mustExclude: [["API design", "API doc"], ["venue"]],
      },
      {
        at: "2026-10-01T09:05:00+02:00",
        question: "What did I promise Anna?",
        mustInclude: [["cost report", "Q3 cost"]],
        mustExclude: [["onboarding dashboard"], ["wiki"]],
      },
      {
        at: "2026-10-01T09:10:00+02:00",
        question: "Hvad har jeg lovet Peter?",
        mustInclude: [["wiki"]],
        mustExclude: [["cost report"], ["onboarding dashboard"]],
      },
      {
        at: "2026-10-01T09:15:00+02:00",
        question: "Did I have any ideas about our CI setup?",
        mustInclude: [["Forgejo Actions", "Jenkins"]],
        mustExclude: [],
      },
    ],
  },
  {
    // Danish notes with the timing people actually use, on the calendar.
    // October 2026: Mon 5 is week 41, Mon 12 week 42; Thu 8 and Fri 9.
    name: "dansk-kalender",
    steps: [
      {
        at: "2026-10-05T08:50:00+02:00",
        text: "Jeg har lovet Birgit i Finance at jeg skal sørge for at vores leverandørafstemning er opdateret jf. hendes besked inden næste kørsel d. 30. oktober.",
      },
      {
        at: "2026-10-05T09:20:00+02:00",
        text: "Mikkel spurgte om jeg kunne kigge på hans budgetmodel i uge 42. Sagde ja.",
      },
      {
        at: "2026-10-05T11:00:00+02:00",
        text: "Møde med Sofie torsdag kl. 10 om rekrutteringen.",
      },
      {
        at: "2026-10-06T08:15:00+02:00",
        text: "Husk at forny parkeringstilladelsen inden fredag.",
      },
      {
        at: "2026-10-06T13:40:00+02:00",
        text: "Jeg skal have afleveret momsregnskabet næste måned.",
      },
      {
        at: "2026-10-06T16:05:00+02:00",
        text: "Når releasen er ude skal jeg skrive release notes til kunderne.",
      },
      {
        at: "2026-10-07T10:30:00+02:00",
        text: "øh så Pia spurgte lige om jeg ku sende hende tallene for september, sagde ja selvf, skal bare gøres inden fredag i næste uge",
      },
      {
        at: "2026-10-07T12:10:00+02:00",
        text: "Frokost med holdet i dag, god stemning.",
      },
      {
        at: "2026-10-09T09:00:00+02:00",
        text: "Birgit skrev at kørslen er rykket til 6. november, så afstemningen skal først være klar til der.",
      },
      {
        at: "2026-10-14T15:30:00+02:00",
        text: "Har sendt september-tallene til Pia.",
      },
    ],
    ledger: [
      {
        phrases: ["leverandørafstemning", "vendor reconciliation", "afstemning"],
        status: "open",
        requestedBy: "Birgit",
        commitment: true,
        due: ["2026-11-05", "2026-11-06"],
      },
      {
        phrases: ["budgetmodel", "budget model"],
        status: "open",
        requestedBy: "Mikkel",
        commitment: true,
        start: ["2026-10-12"],
        due: ["2026-10-16", "2026-10-18"],
      },
      {
        phrases: ["Sofie"],
        status: "open",
        commitment: false,
        start: ["2026-10-08 10:00"],
      },
      {
        phrases: ["parkering"],
        status: "open",
        commitment: true,
        due: ["2026-10-08", "2026-10-09"],
      },
      {
        phrases: ["moms"],
        status: "open",
        commitment: true,
        start: ["2026-11-01"],
        due: ["2026-11-30"],
      },
      {
        phrases: ["release notes"],
        status: "open",
        commitment: true,
        undated: true,
      },
      {
        phrases: ["september", "tallene", "Pia"],
        status: "closed",
        requestedBy: "Pia",
        commitment: true,
        due: ["2026-10-15", "2026-10-16"],
        filler: ["øh", "selvf", "ku"],
      },
    ],
    probes: [
      {
        at: "2026-10-13T08:30:00+02:00",
        question: "Hvad skal jeg nå i denne uge?",
        mustInclude: [["budgetmodel", "budget model"], ["parkering"]],
        mustExclude: [["moms"], ["leverandørafstemning", "afstemning"]],
      },
      {
        at: "2026-10-13T08:35:00+02:00",
        question: "Hvad er overskredet?",
        mustInclude: [["parkering"]],
        mustExclude: [["budgetmodel", "budget model"], ["moms"]],
      },
      {
        at: "2026-10-15T09:00:00+02:00",
        question: "Hvad har jeg lovet Birgit?",
        mustInclude: [["leverandørafstemning", "vendor reconciliation", "afstemning"]],
        mustExclude: [["moms"], ["budgetmodel"]],
      },
      {
        at: "2026-10-15T09:05:00+02:00",
        question: "What's due in November?",
        mustInclude: [
          ["moms"],
          ["leverandørafstemning", "vendor reconciliation", "afstemning"],
        ],
        mustExclude: [["budgetmodel"], ["parkering"]],
      },
    ],
  },
  {
    name: "questions-are-not-facts",
    steps: [
      {
        at: "2026-09-02T10:00:00+02:00",
        text: "Is the staging server still on Ubuntu 20.04?",
      },
      {
        at: "2026-09-02T10:30:00+02:00",
        text: "Checked: the staging server runs Debian 12 now.",
      },
    ],
    ledger: [],
    probes: [
      {
        at: "2026-09-03T09:00:00+02:00",
        question: "What OS does the staging server run?",
        mustInclude: [["Debian"]],
        mustExclude: [["Ubuntu"]],
      },
    ],
  },
];
