// The published client, as an app imports it, typed by declarations generated for a real document.
import { createClient } from "kanagata/client";
import type { paths } from "../.real-specs/out/github.d.ts";

const api = createClient<paths>({ baseUrl: "https://api.github.com" });

export async function issueTitles(): Promise<string[]> {
	const res = await api.get("/repos/{owner}/{repo}/issues", {
		path: { owner: "nodejs", repo: "node" },
		query: { state: "open" },
	});
	return res.status === 200 ? res.data.map((issue) => issue.title) : [];
}
