// 只根据明确身份过滤。“有子代理数量”描述父会话，不是自身身份；标题不参与判定。
export function isSubagentSession(session) {
  return session?.status?.isSubagent === true;
}

export function splitSubagentSessions(sessions, showSubagents = false) {
  const subagents = sessions.filter(isSubagentSession);
  return { visible: showSubagents ? sessions : sessions.filter((s) => !isSubagentSession(s)), total: subagents.length };
}
