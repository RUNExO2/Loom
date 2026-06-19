export interface MutationStep {
  name: string;
  execute: () => Promise<any>;
  rollback: () => Promise<void>;
}

export interface Mutation {
  id: string;
  name: string;
  steps: MutationStep[];
  rollbackSteps: MutationStep[];
  status: 'pending' | 'committed' | 'failed' | 'rolled_back';
  error?: string;
}

class MutationEngine {
  private frozen: boolean = false;

  public freeze() {
    this.frozen = true;
  }

  public unfreeze() {
    this.frozen = false;
  }

  public async executeMutation(name: string, steps: MutationStep[]): Promise<any> {
    if (this.frozen) {
      console.warn(`Blocked mutation [${name}] because the system is frozen.`);
      throw new Error(`System is frozen. Cannot execute: ${name}`);
    }

    const mutation: Mutation = {
      id: Math.random().toString(36).substring(2),
      name,
      steps,
      rollbackSteps: [],
      status: 'pending'
    };

    const executedSteps: MutationStep[] = [];

    try {
      let finalResult: any = null;
      for (const step of steps) {
        finalResult = await step.execute();
        executedSteps.push(step);
        mutation.rollbackSteps.unshift(step); // Rollback in reverse order
      }
      mutation.status = 'committed';
      return finalResult;
    } catch (err: any) {
      console.error(`Mutation [${name}] failed:`, err);
      mutation.status = 'failed';
      
      // Rollback
      for (const rollbackStep of mutation.rollbackSteps) {
        try {
          console.log(`Rolling back step [${rollbackStep.name}]...`);
          await rollbackStep.rollback();
        } catch (rollbackErr) {
          console.error(`Rollback step [${rollbackStep.name}] failed:`, rollbackErr);
        }
      }
      mutation.status = 'rolled_back';
      throw err;
    }
  }
}

export const mutationEngine = new MutationEngine();
