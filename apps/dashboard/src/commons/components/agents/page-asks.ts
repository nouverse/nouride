/**
 * What each page's "Ask Nouva" button writes in the chat box: the page's own job, put as a request to the orchestrator,
 * with a gap ("…") where the person says what they want. A person who does not know the form on the page asks the agent
 * that does, and reads the message before sending it; nothing is sent from the page. One list, so every page's words sit
 * together and read alike.
 */

export interface PageAsk {
  /** Finishes the button's label after the agent's name: "to create an agent" reads "Ask Nouva to create an agent". */
  task: string;
  /** The message written in the chat box, for the person to finish and send. */
  message: string;
}

export const PAGE_ASKS = {
  agents: { task: "to create an agent", message: "I'd like a new agent. What it should do: … Which chat app it should answer on: … Please set it up for me." },
  skills: { task: "to find a skill", message: "Find a skill, or write one, so my agents can … Show me what you found before you add it." },
  connectors: { task: "to connect a service", message: "Connect my agents to … so they can … Tell me what you need from me." },
  automations: { task: "to make an automation", message: "Make an automation for me: when …, do … and send me the result here. Or change one I have: …" },
  missions: { task: "to start a mission", message: "Start a mission: … When it is done, tell me what you did." },
  work: { task: "to take on a task", message: "I have a task that will take a while: … Take it on and tell me how it goes." },
  memory: { task: "to remember something", message: "Remember this for later: …" },
  people: { task: "to add someone", message: "Add someone to People, or update them: their name is …, and they reach us on …" },
  groups: { task: "about a group", message: "In the group …, I'd like my agents to …" },
  models: { task: "to add a model", message: "Add a model for my agents from … Ask me for the key when you need it." },
  integrations: { task: "to connect a chat app", message: "Connect my agents to … (Telegram, Discord or WhatsApp). Walk me through what you need." },
  webSearch: { task: "to set up web search", message: "Set up web search for my agents. Tell me which one you suggest and what you need from me." },
  secrets: { task: "to save a key", message: "I want to save a key for … Ask me for it when you are ready." },
  access: { task: "about who may talk to my agents", message: "Let … talk to my agents on … Or tell me who is waiting to." },
  logs: { task: "to read the logs", message: "Read the recent logs and tell me, in plain words, whether anything is wrong." },
  box: { task: "how the box is doing", message: "How is my box doing? Check its disk, its memory and its updates, and tell me in plain words." },
  office: { task: "what everyone is doing", message: "What is each of my agents doing right now? A line each." },
} as const satisfies Record<string, PageAsk>;

/** The same on one automation's page: the request names the automation, so the agent knows which one is meant. */
export const automationAsk = (name: string): PageAsk => ({ task: "to change it", message: `Change my automation "${name}": …` });
