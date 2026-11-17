import { sessionIdentity } from "../public/usage-fields.js";
import { sourceGroup } from "../public/timeline-utils.js";

export function createFusedSummaryGroups(sourceKindsByPath, modelNameFor, { includeDetails = true } = {}) {
  let memberBytes = 0;
  let active = true;
  const groupsByDimension = {
    channels: new Map(),
    models: new Map(),
    ...(includeDetails ? { homes: new Map(), projects: new Map() } : {}),
  };
  const add = (groups, key, event) => {
    if (!active) return;
    const name = String(key);
    const group = groups.get(name) || {
      key: name,
      name,
      count: 0,
      sessions: new Set(),
      total: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
    };
    group.count += 1;
    const member = sessionIdentity(event.homeId, event.sessionId);
    if (!group.sessions.has(member)) {
      memberBytes += 160 + String(event.sessionId).length * 2;
      if (memberBytes > 1024 * 1024) {
        active = false;
        for (const dimension of Object.values(groupsByDimension)) dimension.clear();
        return;
      }
      group.sessions.add(member);
    }
    group.total.total += event.total.total;
    group.total.input += event.total.input;
    group.total.cached += event.total.cached;
    group.total.output += event.total.output;
    group.total.reasoning += event.total.reasoning;
    groups.set(name, group);
  };
  const materialize = (groups) => {
    const rows = [...groups.values()]
      .map(({ key, name, count, sessions, total }) => ({
        key,
        name,
        count,
        sessions: sessions.size,
        total,
      }))
      .sort((left, right) => right.total.total - left.total.total);
    // SQLite owns tie order, including UTF-8 BINARY collation, so tied dimensions use the old SQL path.
    return rows.some((row, index) => index > 0 && row.total.total === rows[index - 1].total.total) ? null : rows;
  };
  return {
    add(event) {
      add(groupsByDimension.channels, sourceGroup(event.channel, sourceKindsByPath.get(event.sourcePath) ?? ""), event);
      add(groupsByDimension.models, modelNameFor(event.model), event);
      if (includeDetails) {
        add(groupsByDimension.homes, event.homeLabel, event);
        add(groupsByDimension.projects, event.project, event);
      }
    },
    result() {
      if (!active) return null;
      return {
        channels: materialize(groupsByDimension.channels),
        models: materialize(groupsByDimension.models),
        ...(includeDetails
          ? { homes: materialize(groupsByDimension.homes), projects: materialize(groupsByDimension.projects) }
          : {}),
      };
    },
  };
}
