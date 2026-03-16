export interface PaginationLink {
  href: string;
  rel: string;
  title: string;
}

export function buildPaginationLinks(input: {
  basePath: string;
  page: number;
  limit: number;
  totalPages: number;
}): Record<string, PaginationLink> {
  const { basePath, page, limit, totalPages } = input;
  const links: Record<string, PaginationLink> = {};
  links.self = { href: `${basePath}?page=${page}&limit=${limit}`, rel: 'self', title: `Current page (page ${page} of ${totalPages})` };
  links.first = { href: `${basePath}?page=1&limit=${limit}`, rel: 'first', title: 'First page' };
  if (totalPages > 0) {
    links.last = { href: `${basePath}?page=${totalPages}&limit=${limit}`, rel: 'last', title: `Last page (page ${totalPages})` };
  }
  if (page > 1) {
    links.prev = { href: `${basePath}?page=${page - 1}&limit=${limit}`, rel: 'prev', title: `Previous page (page ${page - 1})` };
  }
  if (page < totalPages) {
    links.next = { href: `${basePath}?page=${page + 1}&limit=${limit}`, rel: 'next', title: `Next page (page ${page + 1})` };
  }
  return links;
}
