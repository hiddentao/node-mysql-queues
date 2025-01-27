var currentlyExecutingQueue = null;
var mainQueue = [];
/* Wraps db.query and exposes function db.createQueue() */
module.exports = function(db, debug) {
	if(debug !== true) debug = false;
	if(debug) console.log("mysql-queues: debug mode enabled.");
	var dbQuery = db.query; //The old db.query function
	//Wrap db.query
	db.query = function(sql, params, cb) {
		//Run query if no Queue is running; otherwise, queue it in mainQueue
		if(currentlyExecutingQueue == null)
			return dbQuery.apply(db, arguments);
		else
			mainQueue.push(arguments);
	}
	//Create a new executable query Queue
	db.createQueue = function() {
		return new Queue(function() {return dbQuery.apply(db, arguments);},	function () {
			//If the current Queue is a transaction that has not yet been committed, commit it
			var ceq = currentlyExecutingQueue;
			if(ceq != null && ceq.commit != null)
			{
				//Also, warn the user that relying on this behavior is a bad idea
				if(ceq._autoCommit !== true)
					console.warn("WARNING: mysql-queues: Database transaction was " +
						"implicitly committed.\nIt is HIGHLY recommended that you " +
						"explicitly commit all transactions.\n" +
						"The last query to run was:", ceq.lastExecuted.sql);
				ceq.commit();
				return;
			}
			currentlyExecutingQueue = null;
			//Called when a Queue has completed its processing and main queue should be executed
			while(mainQueue.length > 0)
			{
				var item = mainQueue.shift(); //Unsure of shift's performance
				if(item instanceof Queue)
				{
					item.execute();
					break; //After the Queue has been executed, the main queue will be resumed
				}
				else
					dbQuery.apply(db, item);
			}
		}, debug);
	}
	db.startTransaction = function() {
		return Queue.isNowTransaction(this.createQueue(), function() {return dbQuery.apply(db, arguments);});
	}
}
function Queue(dbQuery, resumeMainQueue, debug) {
	this.queue = [];
	this.paused = false;
	/* Add a query to the Queue */
	this.query = function(sql, params, cb) {
		if(typeof params == "function")
		{
			cb = params;
			params = undefined;
		}
		this.queue.push({
			'sql': sql,
			'params': params,
			'cb': cb
		});
		return this; //Chaining :)
	};
	/* Execute all queries on the Queue in order and prevent other queries from executing until
		all queries have been completed.
	*/
	this.execute = function() {
		if(this.paused === true) return this;
		var that = this;
		//If another Queue is currently running, we put this on the mainQueue
		if(currentlyExecutingQueue != null && currentlyExecutingQueue != this)
			mainQueue.push(this);
		else if(that.queue.length > 0)
		{
			currentlyExecutingQueue = this;
			//console.log("Executing queue:", currentlyExecutingQueue);
			//Run everything in the queue
			var done = 0, total = that.queue.length;
			for(var i in that.queue)
			{
				(function(item) {
					//Execute the query
					try {
						if(item.sql == "COMMIT") delete that.rollback; //Keep 'em honest
						that.lastExecuted = item; //For debugging and convenience
						dbQuery(item.sql, item.params || [], function() {
							if(debug && arguments[0] != null)
								console.error("mysql-queues: An error occurred while executing the following " +
									"query:\n\t", item.sql);
							//Execute the original callback first (which may add more queries to this Queue)
							if(item.cb != null)
								item.cb.apply(this, arguments);
							//When the entire queue has completed...
							if(++done == total)
							{
								if(that.paused === true) return;
								/* The query's callback may have queued more queries on this Queue.
									If so, execute this Queue again; otherwise, resumeMainQueue() */
								if(that.queue.length == 0)
									resumeMainQueue();
								else
									that.execute();
							}
						});
					} catch(e) {
						if(debug)
							console.log("mysql-queues: An exception occurred for this query:\n\t",
								item.sql, "\twith parameters:\n\t", item.params);
						throw e;
					}
				})(that.queue[i]);
			}
			that.queue = [];
			//All queued queries are running, but we don't resume the main queue just yet
			//console.log("Queue Complete:", currentlyExecutingQueue);
		}
		else if(currentlyExecutingQueue == this)
			resumeMainQueue();
		return this; //Chaining :)
	};
	this.pause = function(maxWaitTime) {
		this.paused = true;
		if(maxWaitTime > 0)
		{
			var that = this;
			that.pauseTimer = setTimeout(function() {
				that.resume();
			}, maxWaitTime);
		}
		return this; //Chaining
	}
	this.resume = function() {
		if(this.pauseTimer)
			clearTimeout(this.pauseTimer);
		this.paused = false;
		this.execute();
		return this; //Chaining
	}
}
Queue.isNowTransaction = function(q, dbQuery) {
	q.query("START TRANSACTION");
	q.commit = function(cb) {
		if(this.queue.length > 0)
		{
			this._autoCommit = true;
			this.resume();
		}
		else
		{
			delete this.commit;
			delete this._autoCommit;
			this.query("COMMIT", cb).resume();
		}
	}
	q.rollback = function(cb) {
		this.queue = [];
		delete this.commit;
		delete this.rollback;
		dbQuery("ROLLBACK", cb);
		this.resume();
	}
	return q;
}
