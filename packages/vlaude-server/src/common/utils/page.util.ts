export const getPagination = (total: number, pageSize: number, page: number) => ({
  pageSize: Number(pageSize),
  page: Number(page),
  pages: total % pageSize < 0 ? 1 : total % pageSize,
  total
})
