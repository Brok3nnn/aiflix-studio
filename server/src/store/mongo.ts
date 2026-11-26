/* eslint-disable @typescript-eslint/no-unsafe-class-instance-assignment --
   Mongoose types schema options as a class, but plain option objects are its documented API. */
import mongoose, { Schema, type Connection, type Model } from 'mongoose';
import type { FilmPatch, FilmRecord, FilmStatus, LogEntry } from '../studio/types.ts';
import { definedFields, MAX_LOG_ENTRIES, type FilmRepository } from './repository.ts';

/** A film document: the record with its id stored as `_id`. */
type FilmDocument = Omit<FilmRecord, 'id'> & { _id: string };

const briefSchema = new Schema(
  {
    title: { type: String, required: true },
    premise: { type: String, required: true },
    genres: { type: [String], default: [] },
    look: { type: String, enum: ['realistic', 'animated'], required: true },
    durationSeconds: { type: Number, required: true, min: 8, max: 480 },
    minMainCharacters: { type: Number, required: true },
    minSupportingCharacters: { type: Number, required: true },
  },
  { _id: false },
);

const failureSchema = new Schema(
  {
    kind: { type: String, required: true },
    message: { type: String, required: true },
    sceneIndex: { type: Number, default: null },
    resumable: { type: Boolean, required: true },
  },
  { _id: false },
);

const storySchema = new Schema(
  {
    synopsis: String,
    theme: String,
    styleMedium: String,
    visualStyle: String,
    locations: [String],
    continuityRules: [String],
    relationships: [String],
    timeline: [String],
  },
  { _id: false },
);

const castSchema = new Schema(
  {
    characterId: String,
    name: String,
    roleType: { type: String, enum: ['main', 'supporting'] },
    storyRole: String,
    appearance: String,
    wardrobe: String,
    visualSignature: String,
  },
  { _id: false },
);

const sceneSchema = new Schema(
  {
    index: Number,
    title: String,
    beat: String,
    location: String,
    timeMarker: String,
    characterIds: [String],
    durationSeconds: Number,
  },
  { _id: false },
);

const clipSchema = new Schema({ sceneIndex: Number, file: String, durationSeconds: Number }, { _id: false });

const logSchema = new Schema(
  { at: String, level: { type: String, enum: ['info', 'warn', 'error'] }, message: String },
  { _id: false },
);

const filmSchema = new Schema<FilmDocument>(
  {
    _id: { type: String, required: true },
    brief: { type: briefSchema, required: true },
    status: {
      type: String,
      enum: ['queued', 'generating', 'ready', 'failed'],
      required: true,
      index: true,
    },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    statusText: { type: String, default: '' },
    failure: { type: failureSchema, default: null },
    story: { type: storySchema, default: null },
    cast: { type: [castSchema], default: [] },
    scenes: { type: [sceneSchema], default: [] },
    clips: { type: [clipSchema], default: [] },
    videoFile: { type: String, default: null },
    posterFile: { type: String, default: null },
    logs: { type: [logSchema], default: [] },
    createdAt: { type: String, required: true, index: true },
    updatedAt: { type: String, required: true },
  },
  { versionKey: false, minimize: false },
);

function toRecord(document: FilmDocument): FilmRecord {
  const { _id: id, ...rest } = document;
  return { id, ...rest };
}

export class MongoFilmRepository implements FilmRepository {
  readonly kind = 'mongo';
  readonly #connection: Connection;
  readonly #films: Model<FilmDocument>;
  readonly #now: () => Date;

  private constructor(connection: Connection, now: () => Date) {
    this.#connection = connection;
    this.#films = connection.model<FilmDocument>('Film', filmSchema, 'films');
    this.#now = now;
  }

  static async connect(uri: string, now: () => Date = () => new Date()): Promise<MongoFilmRepository> {
    const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5_000 });
    await connection.asPromise();
    return new MongoFilmRepository(connection, now);
  }

  async create(film: FilmRecord): Promise<void> {
    const { id, ...rest } = film;
    await this.#films.create({ _id: id, ...rest });
  }

  async get(id: string): Promise<FilmRecord | null> {
    const document = await this.#films.findById(id).lean<FilmDocument>().exec();
    return document ? toRecord(document) : null;
  }

  async list(limit: number): Promise<FilmRecord[]> {
    const documents = await this.#films
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<FilmDocument[]>()
      .exec();
    return documents.map(toRecord);
  }

  async listByStatus(statuses: readonly FilmStatus[]): Promise<FilmRecord[]> {
    const documents = await this.#films
      .find({ status: { $in: [...statuses] } })
      .lean<FilmDocument[]>()
      .exec();
    return documents.map(toRecord);
  }

  async update(id: string, patch: FilmPatch, log?: LogEntry): Promise<FilmRecord | null> {
    const update = {
      $set: { ...definedFields(patch), updatedAt: this.#now().toISOString() },
      ...(log ? { $push: { logs: { $each: [log], $slice: -MAX_LOG_ENTRIES } } } : {}),
    };
    const document = await this.#films
      .findByIdAndUpdate(id, update, { returnDocument: 'after' })
      .lean<FilmDocument>()
      .exec();
    return document ? toRecord(document) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.#films.deleteOne({ _id: id }).exec();
    return result.deletedCount > 0;
  }

  async close(): Promise<void> {
    await this.#connection.close();
  }
}
