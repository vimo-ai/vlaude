export class PaginationDTO<T> {
 readonly page?: number;

 readonly pageSize?: number;

 pages: number;

 total: number;

 list: Array<T>
}
