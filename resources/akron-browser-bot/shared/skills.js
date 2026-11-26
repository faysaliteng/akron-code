/** Agent Skills documents: YAML frontmatter plus markdown instructions. */

export function parseSkillMd(source) {
  const text = String(source || "").replace(/^\uFEFF/, "");
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  let body = text.trim();
  if (match) {
    body = match[2].trim();
    for (const line of match[1].split("\n")) {
      const cut = line.indexOf(":");
      if (cut === -1) continue;
      const key = line.slice(0, cut).trim();
      const value = line.slice(cut + 1).trim().replace(/^["']|["']$/g, "");
      if (key) meta[key] = value;
    }
  }
  const name = meta.name || "Untitled skill";
  return {
    name,
    description: meta.description || "",
    instructions: body,
  };
}

export function serializeSkillMd(skill) {
  const name = String(skill?.name || "Untitled skill").replace(/\n/g, " ");
  const description = String(skill?.description || "").replace(/\n/g, " ");
  const body = String(skill?.instructions || "").trim();
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

export function matchSkills(query, skills, limit = 3) {
  const wanted = new Set(tokens(query));
  return (skills || [])
    .filter((skill) => skill && skill.enabled !== false)
    .map((skill) => {
      const hay = new Set(tokens(`${skill.name} ${skill.description}`));
      let score = 0;
      for (const word of wanted) if (hay.has(word)) score += 1;
      if (tokens(skill.name).some((word) => wanted.has(word))) score += 2;
      return { skill, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.skill);
}

export function skillCatalog(skills) {
  return (skills || [])
    .filter((skill) => skill && skill.enabled !== false)
    .map((skill) => `- ${skill.name}: ${skill.description || "No description."}`)
    .join("\n");
}
