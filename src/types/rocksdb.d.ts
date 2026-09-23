declare module "rocksdb" {
  const rocksdb: (location: string) => any;
  export default rocksdb;
}
