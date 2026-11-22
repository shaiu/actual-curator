/** Which app serves a path: the two page apps own their path and everything under it; the rest is the API. */
export const pageFor = (path: string): 'money' | 'budget' | 'api' =>
  path === '/money' ? 'money' : path === '/budget' || path.startsWith('/budget/') ? 'budget' : 'api';
