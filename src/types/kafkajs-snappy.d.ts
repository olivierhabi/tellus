// F-P3 hygiene: kafkajs-snappy ships JS-only, add a minimal module declaration
// so tsc does not fail on the import in mergedKafkaProducer.ts. The runtime
// behaviour is unchanged; this only satisfies the type checker.
declare module 'kafkajs-snappy' {
  import type { CompressionCodecs } from 'kafkajs';
  const SnappyCodec: CompressionCodecs[keyof CompressionCodecs];
  export default SnappyCodec;
}
